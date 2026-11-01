const std = @import("std");

pub fn build(b: *std.Build) void {
    const supermd_dep = b.dependency("supermd", .{ .target = b.graph.host, .optimize = .Debug });
    const supermd = supermd_dep.module("supermd");
    const markdown = b.createModule(.{
        .root_source_file = b.path("src/markdown.zig"),
        .target = b.graph.host,
        .optimize = .Debug,
    });

    const tests_module = b.createModule(.{
        .root_source_file = b.path("tests/markdown_test.zig"),
        .target = b.graph.host,
        .optimize = .Debug,
    });
    markdown.addImport("supermd", supermd);
    tests_module.addImport("markdown", markdown);
    const tests = b.addTest(.{ .root_module = tests_module });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Test Markdown publishing policy");
    test_step.dependOn(&run_tests.step);

    const publisher = b.addExecutable(.{
        .name = "publish-markdown",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/publish.zig"),
            .target = b.graph.host,
            .optimize = .Debug,
        }),
    });

    publisher.root_module.addImport("supermd", supermd);
    const generate = b.addRunArtifact(publisher);
    const publish_step = b.step("publish", "Generate published Markdown articles");
    publish_step.dependOn(&generate.step);

    const verify = b.addRunArtifact(publisher);
    verify.addArg("--verify");
    const verify_step = b.step("verify", "Verify Zine HTML and Markdown outputs");
    verify_step.dependOn(&verify.step);
}
