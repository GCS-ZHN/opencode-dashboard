"""Assert-based tests for the aggregation logic, driven via SqliteRunner."""

from aggregate import (
    models,
    normalize_model,
    overview,
    project_detail,
    projects,
    session_detail,
)

ZERO_TOKENS = {"input": 0, "output": 0, "reasoning": 0,
               "cacheRead": 0, "cacheWrite": 0, "total": 0}

DIR_DASH = "dir:" + b"/Users/test/projects/opencode-dashboard".hex()
DIR_TMP = "dir:" + b"/private/tmp".hex()


def test_overview_rollup(runner):
    o = overview(runner)
    assert o["projectCount"] == 5
    assert o["sessionCount"] == 8
    assert o["mainSessionCount"] == 7  # s3 is the only subagent
    assert o["cost"] == 7.4
    assert o["tokens"] == {"input": 4100, "output": 1980, "reasoning": 900,
                           "cacheRead": 350, "cacheWrite": 173, "total": 7503}
    assert o["updatedAt"] == 190000


def test_projects_ordered_by_cost_desc(runner):
    ps = projects(runner)
    assert [p["id"] for p in ps] == [
        "proj-ccc", "proj-aaa", "proj-bbb", DIR_DASH, DIR_TMP,
    ]
    p1 = ps[1]
    assert p1["name"] == "dash"
    assert p1["worktree"] == "/Users/test/projects/dash"
    assert p1["sessionCount"] == 3
    assert p1["mainSessionCount"] == 2  # s1, s2 roots; s3 is s1's subagent
    assert p1["cost"] == 2.7
    assert p1["tokens"]["input"] == 1400
    assert p1["tokens"]["total"] == 1400 + 650 + 270 + 115 + 57


def test_global_catchall_sessions_split_by_directory(runner):
    ps = {p["id"]: p for p in projects(runner)}
    dash = ps[DIR_DASH]
    tmp = ps[DIR_TMP]
    assert dash["name"] == "opencode-dashboard"
    assert dash["sessionCount"] == 1  # only s8, not the tmp/home sessions
    assert dash["cost"] == 0.2
    assert tmp["name"] == "tmp"
    assert tmp["sessionCount"] == 1  # only s7
    assert tmp["cost"] == 0.1
    assert "global" not in ps  # catch-all bucket itself is never shown as a project


def test_global_dir_group_detail(runner):
    proj, sessions = project_detail(runner, DIR_TMP)
    assert proj["name"] == "tmp"
    assert [s["id"] for s in sessions] == ["s7"]


def test_project_detail_flat_sessions(runner):
    proj, sessions = project_detail(runner, "proj-aaa")
    assert proj["name"] == "dash"
    assert [s["id"] for s in sessions] == ["s1", "s2", "s3"]
    by_id = {s["id"]: s for s in sessions}
    assert by_id["s1"]["parentId"] is None
    assert by_id["s3"]["parentId"] == "s1"
    assert by_id["s1"]["model"] == "deepseek-v4-flash"
    assert by_id["s1"]["tokens"]["total"] == 1000 + 500 + 200 + 100 + 50


def test_session_detail_model_breakdown(runner):
    sess, models = session_detail(runner, "s4")
    assert sess["cost"] == 0.9
    # per-session breakdown keeps (model, provider, mode) granularity, so the
    # deepseek/build + openrouter/plan pair for the same model id stays split
    assert [m["model"] for m in models] == ["deepseek-v4-flash", "claude-sonnet-4.5", "deepseek-v4-flash"]
    assert [m["provider"] for m in models] == ["deepseek", "opencode", "openrouter"]
    flash = models[0]
    assert flash["provider"] == "deepseek"
    assert flash["mode"] == "build"
    assert flash["messageCount"] == 2
    assert flash["tokens"] == {"input": 200, "output": 100, "reasoning": 50,
                               "cacheRead": 20, "cacheWrite": 10, "total": 380}
    assert flash["cost"] == 0.6
    claude = models[1]
    assert claude["messageCount"] == 1
    assert claude["tokens"] == {"input": 200, "output": 100, "reasoning": 50,
                                "cacheRead": 0, "cacheWrite": 0, "total": 350}
    assert claude["cost"] == 0.3
    flash2 = models[2]
    assert flash2["provider"] == "openrouter"
    assert flash2["mode"] == "plan"
    assert flash2["messageCount"] == 1
    assert flash2["tokens"] == {"input": 50, "output": 20, "reasoning": 10,
                                "cacheRead": 5, "cacheWrite": 2, "total": 87}
    assert flash2["cost"] == 0.1


def test_zero_token_session_is_zeros_not_null(runner):
    sess, models = session_detail(runner, "s5")
    assert sess["cost"] == 0.0
    assert sess["tokens"] == ZERO_TOKENS
    assert len(models) == 1
    assert models[0]["tokens"] == ZERO_TOKENS
    assert models[0]["cost"] == 0.0
    assert models[0]["messageCount"] == 1


def test_session_without_messages_has_empty_models(runner):
    sess, models = session_detail(runner, "s6")
    assert sess["model"] == "deepseek-v4-pro"  # provider prefix stripped
    assert models == []


def test_normalize_model():
    assert normalize_model("deepseek/deepseek-v4-flash") == "deepseek-v4-flash"
    assert normalize_model("deepseek-v4-flash") == "deepseek-v4-flash"
    assert normalize_model(None) is None


def test_unknown_ids_return_none(runner):
    assert project_detail(runner, "nope") is None
    assert session_detail(runner, "nope") is None


def test_models_hostwide_rollup(runner):
    ms = models(runner)
    # ordered by cost desc (tie by model name); user message in m5 excluded
    assert [m["model"] for m in ms] == ["deepseek-v4-flash", "claude-sonnet-4.5", "kimi-k3"]
    flash = ms[0]
    # m1+m2 (deepseek/build) and m6 (openrouter/plan) share a model id; the
    # host-wide rollup merges them into one entry, keeping the higher-cost label
    assert flash["provider"] == "deepseek"
    assert flash["mode"] == "build"
    assert flash["messageCount"] == 3  # m1 + m2 + m6, not the m5 user message
    assert flash["tokens"] == {"input": 250, "output": 120, "reasoning": 60,
                               "cacheRead": 25, "cacheWrite": 12, "total": 467}
    assert flash["cost"] == 0.7
    claude = ms[1]
    assert claude["provider"] == "opencode"
    assert claude["messageCount"] == 1
    assert claude["tokens"]["total"] == 350
    assert claude["cost"] == 0.3
    kimi = ms[2]
    assert kimi["messageCount"] == 1  # only m4; the m5 user message is excluded
    assert kimi["tokens"] == ZERO_TOKENS
    assert kimi["cost"] == 0.0
