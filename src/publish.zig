//! Build and verify the Markdown counterparts of published local blog posts.
const std = @import("std");
const markdown = @import("markdown.zig");

const source_dir = "content/blog";
const assets_dir = "assets/blog";
const public_dir = "public/blog";
const Mode = enum { generate, verify };

pub const std_options: std.Options = .{ .log_level = .info };

fn read(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(1024 * 1024));
}

fn checkFile(io: std.Io, allocator: std.mem.Allocator, path: []const u8, expected: []const u8) !void {
    const actual = read(io, allocator, path) catch |err| switch (err) {
        error.FileNotFound => return error.MissingPublishedMarkdown,
        else => |e| return e,
    };
    defer allocator.free(actual);
    if (!std.mem.eql(u8, actual, expected)) return error.PublishedMarkdownMismatch;
}

fn missing(io: std.Io, path: []const u8) !bool {
    std.Io.Dir.cwd().access(io, path, .{}) catch |err| switch (err) {
        error.FileNotFound => return true,
        else => |e| return e,
    };
    return false;
}

pub fn run(allocator: std.mem.Allocator, io: std.Io, mode: Mode) !void {
    var sources = try std.Io.Dir.cwd().openDir(io, source_dir, .{ .iterate = true });
    defer sources.close(io);
    if (mode == .generate) {
        // Owned generated output: remove stale files from deleted or drafted posts.
        try std.Io.Dir.cwd().deleteTree(io, assets_dir);
        try std.Io.Dir.cwd().createDirPath(io, assets_dir);
    }
    var count: usize = 0;
    var iter = sources.iterate();
    while (try iter.next(io)) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".smd")) continue;
        if (std.mem.eql(u8, entry.name, "index.smd")) continue;

        const input = try sources.readFileAlloc(io, entry.name, allocator, .limited(1024 * 1024));
        defer allocator.free(input);
        const page = try markdown.parse(input);
        const slug = entry.name[0 .. entry.name.len - ".smd".len];
        const asset_path = try std.fmt.allocPrint(allocator, "{s}/{s}.md", .{ assets_dir, slug });
        defer allocator.free(asset_path);
        const published_path = try std.fmt.allocPrint(allocator, "{s}/{s}.md", .{ public_dir, slug });
        defer allocator.free(published_path);

        if (!page.isPublishable()) {
            if (mode == .verify) {
                if (!try missing(io, asset_path)) return error.UnpublishedArticleInAssets;
                if (!try missing(io, published_path)) return error.UnpublishedArticleInPublic;
                if (page.draft) {
                    const html_path = try std.fmt.allocPrint(allocator, "{s}/{s}/index.html", .{ public_dir, slug });
                    defer allocator.free(html_path);
                    if (!try missing(io, html_path)) return error.DraftHtmlPublished;
                }
            }
            continue;
        }

        const output = try markdown.render(allocator, page);
        defer allocator.free(output);
        if (mode == .generate) {
            try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = asset_path, .data = output });
        } else {
            try checkFile(io, allocator, asset_path, output);
            try checkFile(io, allocator, published_path, output);
            const html_path = try std.fmt.allocPrint(allocator, "{s}/{s}/index.html", .{ public_dir, slug });
            defer allocator.free(html_path);
            if (try missing(io, html_path)) return error.PublishedHtmlMissing;
        }
        count += 1;
    }
    if (count == 0) return error.NoPublishedArticles;

    if (mode == .verify) {
        // Reject orphaned Markdown left by deleted or newly drafted posts.
        var published = try std.Io.Dir.cwd().openDir(io, public_dir, .{ .iterate = true });
        defer published.close(io);
        var out_iter = published.iterate();
        var seen: usize = 0;
        while (try out_iter.next(io)) |entry| {
            if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".md")) continue;
            seen += 1;
        }
        if (seen != count) return error.UnexpectedMarkdownOutput;
    }
}

pub fn main(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len > 2) return error.InvalidArguments;
    const mode: Mode = if (args.len == 1) .generate else if (std.mem.eql(u8, args[1], "--verify")) .verify else return error.InvalidArguments;
    try run(init.gpa, init.io, mode);
}
