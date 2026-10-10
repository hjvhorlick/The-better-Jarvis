import pytest

from backend.permissions import PermissionPolicy, Tier, default_policy


def test_unknown_actions_are_denied_by_default():
    d = PermissionPolicy().decide("files.delete_everything", confirmed=True)
    assert d.allowed is False and d.reason == "unknown action"


def test_safe_actions_run_without_confirmation():
    p = PermissionPolicy()
    p.register("weather.read", Tier.SAFE)
    assert p.decide("weather.read").allowed is True


def test_confirm_actions_need_a_confirmation_for_each_call():
    p = PermissionPolicy()
    p.register("files.write", Tier.CONFIRM)
    first = p.decide("files.write")
    assert first.allowed is False and first.needs_confirmation is True
    assert p.decide("files.write", confirmed=True).allowed is True


def test_blocked_actions_never_run_even_when_confirmed():
    p = PermissionPolicy()
    p.register("danger", Tier.BLOCKED)
    d = p.decide("danger", confirmed=True)
    assert d.allowed is False and d.needs_confirmation is False


def test_browser_policy_blocks_shell_and_self_modification_even_if_confirmed():
    p = default_policy()
    for action in ("shell.run", "code.self_modify"):
        d = p.decide(action, confirmed=True)
        assert d.allowed is False, action
        assert d.needs_confirmation is False, action


def test_each_action_is_registered_once():
    p = PermissionPolicy()
    p.register("a", Tier.SAFE)
    with pytest.raises(ValueError):
        p.register("a", Tier.CONFIRM)
    with pytest.raises(ValueError):
        p.register("", Tier.SAFE)
