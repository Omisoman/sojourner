"""The sandbox walls, read from the compose file and env files themselves:
who sits on which network, who may publish a port, who holds which secret."""

from __future__ import annotations

from pathlib import Path

import jwt
import pytest
import yaml

ROOT = Path(__file__).parents[1]
COMPOSE = ROOT / "infra" / "compose"
HORIZONS_COMPOSE = ROOT.parent / "new-horizons" / "docker-compose.yml"
SPEC = yaml.safe_load((COMPOSE / "docker-compose.yml").read_text())
SERVICES = SPEC["services"]
NETS = SPEC["networks"]


def env_file(name: str) -> dict[str, str]:
    out = {}
    for line in (COMPOSE / name).read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k] = v
    return out


def _internal(net: str) -> bool:
    return bool(NETS[net].get("internal")) or NETS[net].get("external") is True


def test_tier_and_ops_networks_are_internal_and_the_database_is_horizons_s():
    assert NETS["tier-net"]["internal"] and NETS["ops-net"]["internal"]
    assert NETS["horizons-db"] == {"external": True, "name": "horizons-db"}


@pytest.mark.parametrize("service", ["tier1", "tier2", "staging"])
def test_agent_code_never_sits_on_a_routable_network(service):
    """tier-1 is the agent, tier-2 drives it, staging RUNS what it wrote."""
    assert all(_internal(n) for n in SERVICES[service]["networks"]), SERVICES[service]["networks"]
    assert "ports" not in SERVICES[service]


def test_tier1_reaches_only_tier2_and_the_model_proxy():
    assert SERVICES["tier1"]["networks"] == ["tier-net"]
    on_tier_net = {s for s, d in SERVICES.items() if "tier-net" in d.get("networks", [])}
    assert on_tier_net == {"tier1", "tier2", "llm-proxy", "litellm"}


def test_only_the_model_proxies_and_caddy_have_a_route_out():
    routable = {s for s, d in SERVICES.items() if not all(_internal(n) for n in d.get("networks", []))}
    assert routable == {"llm-proxy", "litellm", "caddy"}
    assert {s for s, d in SERVICES.items() if "ports" in d} == {"caddy"}


@pytest.mark.parametrize("service", ["tier1", "tier2", "staging"])
def test_walls_read_only_no_caps_no_privilege_gain(service):
    d = SERVICES[service]
    assert d["read_only"] is True and d["cap_drop"] == ["ALL"]
    assert "no-new-privileges" in d["security_opt"] and d["user"] == "agent"


def test_staging_serves_the_deployed_source_read_only():
    vols = SERVICES["staging"]["volumes"]
    assert "staging-src:/srv/staging:ro" in vols
    assert "staging-src:/srv/staging" in SERVICES["tier2"]["volumes"]       # only tier-2 writes it
    assert "staging-run:/srv/staging-run:ro" in SERVICES["tier2"]["volumes"]


def test_tier1_holds_no_credentials():
    t1 = env_file("tier1.env")
    assert not {k for k in t1 if k.startswith(("GITEA", "DATABASE", "A2A_JWT", "NTFY", "STAGING"))}
    assert t1["LLM_BASE_URL"] == "http://llm-proxy:11434/v1"


def test_tier1_bearer_is_signed_for_its_role_by_tier2_s_secret():
    fields = jwt.decode(env_file("tier1.env")["A2A_BEARER_TIER1"],
                        env_file("tier2.env")["A2A_JWT_SECRET"], algorithms=["HS256"])
    assert fields == {"role": "tier1-dev", "sub": "tier1"}


def test_tier2_and_staging_share_horizons_s_database_staging_holds_no_ops_secret():
    t2, st = env_file("tier2.env"), env_file("staging.env")
    for env in (t2, st):
        assert env["DATABASE_URL"] == "postgresql://horizons:horizons@horizons-postgres:5432/horizons"
        assert env["DATABASE_URL_RO"].startswith("postgresql://farm_ro:")
    assert not {k for k in st if k.startswith(("GITEA", "A2A", "NTFY", "STAGING"))}
    assert st["HORIZONS_DATA"] == "/srv/farm/data"


@pytest.mark.skipif(not HORIZONS_COMPOSE.exists(), reason="sibling new-horizons checkout not present")
def test_horizons_owns_the_internal_database_network():
    horizons = yaml.safe_load(HORIZONS_COMPOSE.read_text())
    assert horizons["networks"]["farm-db"] == {"name": "horizons-db", "internal": True}
    assert "farm-db" in horizons["services"]["postgres"]["networks"]
    assert horizons["services"]["postgres"]["container_name"] == "horizons-postgres"
