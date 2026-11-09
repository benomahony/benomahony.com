//! Build and verify the Markdown counterparts of published local blog posts.
const std = @import("std");
const markdown = @import("markdown.zig");

const source_dir = "content/blog";
const assets_dir = "assets/blog";
const public_dir = "public/blog";
const Mode = enum { generate, verify };

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

/// Output locations for one article, derived from its slug.
const Paths = struct {
    asset: []const u8,
    published: []const u8,
    html: []const u8,

    fn init(allocator: std.mem.Allocator, slug: []const u8) !Paths {
        const asset = try std.fmt.allocPrint(allocator, "{s}/{s}.md", .{ assets_dir, slug });
        errdefer allocator.free(asset);
        const published = try std.fmt.allocPrint(allocator, "{s}/{s}.md", .{ public_dir, slug });
        errdefer allocator.free(published);
        const html = try std.fmt.allocPrint(allocator, "{s}/{s}/index.html", .{ public_dir, slug });
        return .{ .asset = asset, .published = published, .html = html };
    }

    fn deinit(self: Paths, allocator: std.mem.Allocator) void {
        allocator.free(self.asset);
        allocator.free(self.published);
        allocator.free(self.html);
    }
};

fn verifyUnpublished(io: std.Io, page: markdown.Page, paths: Paths) !void {
    if (!try missing(io, paths.asset)) return error.UnpublishedArticleInAssets;
    if (!try missing(io, paths.published)) return error.UnpublishedArticleInPublic;
    if (page.draft and !try missing(io, paths.html)) return error.DraftHtmlPublished;
}

/// The settings every per-article step shares.
const Publisher = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    mode: Mode,

    fn publishArticle(self: Publisher, page: markdown.Page, paths: Paths) !void {
        const output = try markdown.render(self.allocator, page);
        defer self.allocator.free(output);
        switch (self.mode) {
            .generate => try std.Io.Dir.cwd().writeFile(self.io, .{ .sub_path = paths.asset, .data = output }),
            .verify => {
                try checkFile(self.io, self.allocator, paths.asset, output);
                try checkFile(self.io, self.allocator, paths.published, output);
                if (try missing(self.io, paths.html)) return error.PublishedHtmlMissing;
            },
        }
    }

    /// Handle one entry of the source directory and report whether it is a published article.
    fn processEntry(self: Publisher, sources: std.Io.Dir, entry: std.Io.Dir.Entry) !bool {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.name, ".smd")) return false;
        if (std.mem.eql(u8, entry.name, "index.smd")) return false;

        const input = try sources.readFileAlloc(self.io, entry.name, self.allocator, .limited(1024 * 1024));
        defer self.allocator.free(input);
        const page = try markdown.parse(input);
        const paths = try Paths.init(self.allocator, entry.name[0 .. entry.name.len - ".smd".len]);
        defer paths.deinit(self.allocator);

        if (!page.isPublishable()) {
            if (self.mode == .verify) try verifyUnpublished(self.io, page, paths);
            return false;
        }
        try self.publishArticle(page, paths);
        return true;
    }
};

/// Count the Markdown files in the published output, so orphans left by deleted or drafted posts are caught.
fn countPublishedMarkdown(io: std.Io) !usize {
    var published = try std.Io.Dir.cwd().openDir(io, public_dir, .{ .iterate = true });
    defer published.close(io);
    var iter = published.iterate();
    var seen: usize = 0;
    while (try iter.next(io)) |entry| {
        if (entry.kind == .file and std.mem.endsWith(u8, entry.name, ".md")) seen += 1;
    }
    return seen;
}

pub fn run(allocator: std.mem.Allocator, io: std.Io, mode: Mode) !void {
    const cwd = std.Io.Dir.cwd();
    var sources = try cwd.openDir(io, source_dir, .{ .iterate = true });
    defer sources.close(io);
    if (mode == .generate) {
        // Owned generated output: remove stale files from deleted or drafted posts.
        try cwd.deleteTree(io, assets_dir);
        try cwd.createDirPath(io, assets_dir);
    }
    const publisher: Publisher = .{ .allocator = allocator, .io = io, .mode = mode };
    var count: usize = 0;
    var iter = sources.iterate();
    while (try iter.next(io)) |entry| {
        if (try publisher.processEntry(sources, entry)) count += 1;
    }
    if (count == 0) return error.NoPublishedArticles;
    if (mode == .verify and try countPublishedMarkdown(io) != count) return error.UnexpectedMarkdownOutput;
}

fn parseMode(allocator: std.mem.Allocator, args: std.process.Args) !Mode {
    const argv = try args.toSlice(allocator);
    if (argv.len == 1) return .generate;
    if (argv.len == 2 and std.mem.eql(u8, argv[1], "--verify")) return .verify;
    return error.InvalidArguments;
}

pub fn main(init: std.process.Init) !void {
    const mode = try parseMode(init.arena.allocator(), init.minimal.args);
    try run(init.gpa, init.io, mode);
}
