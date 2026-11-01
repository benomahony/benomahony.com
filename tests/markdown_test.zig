const std = @import("std");
const markdown = @import("markdown");

test "published article produces portable Markdown" {
    const page = try markdown.parse(
        "---\n.title = \"Rules\",\n.layout = \"post.shtml\",\n---\n\n" ++
        "Intro.\n\n# [1. Rule]($heading.id('rule'))\n\n_Body_\n");
    try std.testing.expect(page.isPublishable());
    const rendered = try markdown.render(std.testing.allocator, page);
    defer std.testing.allocator.free(rendered);
    try std.testing.expectEqualStrings("# Rules\n\nIntro.\n\n# 1\\. Rule\n\n*Body*\n", rendered);
}

test "drafts are excluded and external posts are not mirrored" {
    const draft = try markdown.parse("---\n.title = \"Draft\",\n.layout = \"post.shtml\",\n.draft = true,\n---\n\nNot ready\n");
    const external = try markdown.parse("---\n.title = \"Elsewhere\",\n.layout = \"external.shtml\",\n---\n\nExternal\n");
    const published = try markdown.parse("---\n.title = \"Published\",\n.layout = \"post.shtml\",\n.draft = false,\n---\n\nReady\n");
    try std.testing.expect(!draft.isPublishable());
    try std.testing.expect(!external.isPublishable());
    try std.testing.expect(published.isPublishable());
}

test "invalid draft value fails closed" {
    try std.testing.expectError(error.InvalidDraft, markdown.parse(
        "---\n.title = \"Draft\",\n.layout = \"post.shtml\",\n.draft = sometimes,\n---\n\nBody\n"));
}

test "invalid input is rejected rather than silently published" {
    try std.testing.expectError(error.InvalidFrontmatter, markdown.parse("hello"));
    try std.testing.expectError(error.MissingField, markdown.parse("---\n.title = \"Foo\",\n---\n\nHello"));
}

test "draft with leading whitespace before frontmatter remains excluded" {
    const page = try markdown.parse("\n---\n.title = \"Draft\",\n.layout = \"post.shtml\",\n.draft = true,\n---\n\nNot public");
    try std.testing.expect(page.draft);
    try std.testing.expect(!page.isPublishable());
}
