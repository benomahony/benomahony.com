//! Metadata selection and Markdown rendering of an actual SuperMD AST.
const std = @import("std");
const supermd = @import("supermd");
const c = supermd.c;

pub const Page = struct {
    title: []const u8,
    layout: []const u8,
    body: []const u8,
    draft: bool,

    pub fn isPublishable(self: Page) bool {
        return !self.draft and std.mem.eql(u8, self.layout, "post.shtml");
    }
};

// Only Ziggy frontmatter metadata is selected here. The body is parsed by SuperMD.
fn field(header: []const u8, key: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, header, '\n');
    while (lines.next()) |line| {
        const cleaned = std.mem.trim(u8, line, " \t\r");
        if (!std.mem.startsWith(u8, cleaned, key)) continue;
        return std.mem.trim(u8, cleaned[key.len..], " \t\r,");
    }
    return null;
}

fn stringField(header: []const u8, key: []const u8) ![]const u8 {
    const raw = field(header, key) orelse return error.MissingField;
    if (raw.len < 2 or raw[0] != '"' or raw[raw.len - 1] != '"') return error.InvalidField;
    return raw[1 .. raw.len - 1];
}

pub fn parse(source: []const u8) !Page {
    const clean = std.mem.trimStart(u8, source, " \t\r\n");
    if (!std.mem.startsWith(u8, clean, "---\n")) return error.InvalidFrontmatter;
    const close = std.mem.indexOf(u8, clean[4..], "\n---\n") orelse return error.InvalidFrontmatter;
    const header = clean[4 .. 4 + close];
    const title = try stringField(header, ".title =");
    const layout = try stringField(header, ".layout =");
    const raw_draft = field(header, ".draft =");
    const draft = if (raw_draft) |value| blk: {
        if (std.mem.eql(u8, value, "true")) break :blk true;
        if (std.mem.eql(u8, value, "false")) break :blk false;
        return error.InvalidDraft;
    } else false;
    if (title.len == 0 or layout.len == 0) return error.InvalidField;
    return .{
        .title = title,
        .layout = layout,
        .draft = draft,
        .body = std.mem.trim(u8, clean[4 + close + "\n---\n".len ..], "\n"),
    };
}

fn portable(ast: supermd.Ast) !void {
    const root = ast.md.root;
    var node = root.firstChild();
    while (node) |n| {
        if (n.getDirective()) |directive| {
            switch (directive.kind) {
                .heading => {
                    if (n.nodeType() != .HEADING) return error.UnsupportedSuperMdDirective;
                    const first = n.firstChild() orelse return error.UnsupportedSuperMdDirective;
                    if (first.nodeType() != .LINK) return error.UnsupportedSuperMdDirective;
                    const link = first.link() orelse return error.UnsupportedSuperMdDirective;
                    if (!std.mem.startsWith(u8, link, "$heading.")) return error.UnsupportedSuperMdDirective;
                    try first.replaceWithChild();
                },
                // Ordinary HTTP(S) links remain valid Markdown links.
                .link => {
                    if (n.nodeType() == .LINK) {
                        const link = n.link() orelse return error.UnsupportedSuperMdDirective;
                        if (std.mem.startsWith(u8, link, "$")) return error.UnsupportedSuperMdDirective;
                    }
                },
                else => return error.UnsupportedSuperMdDirective,
            }
        }
        node = n.next(root);
    }
}

pub fn render(allocator: std.mem.Allocator, page: Page) ![]u8 {
    std.debug.assert(page.title.len > 0);
    c.cmark_gfm_core_extensions_ensure_registered();
    const parser = supermd.Ast.CmarkParser.default();
    defer c.cmark_parser_free(parser.parser);
    const ast = try supermd.Ast.init(allocator, page.body, parser, .{});
    defer ast.deinit(allocator);
    if (ast.errors.len != 0) return error.InvalidSuperMd;
    try portable(ast);
    const raw = c.cmark_render_commonmark(ast.md.root.n, c.CMARK_OPT_DEFAULT, 0) orelse return error.OutOfMemory;
    defer c.cmark_get_default_mem_allocator().*.free.?(raw);
    const converted = std.mem.trim(u8, std.mem.span(raw), "\n");
    return std.fmt.allocPrint(allocator, "# {s}\n\n{s}\n", .{ page.title, converted });
}
