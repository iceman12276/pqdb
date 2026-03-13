"""Tests for Docker Compose configuration validity.

Validates that infra/compose.yaml is valid YAML, defines expected services,
and that .env.example documents all required environment variables.
"""

from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
INFRA_DIR = REPO_ROOT / "infra"
COMPOSE_FILE = INFRA_DIR / "compose.yaml"
ENV_EXAMPLE = REPO_ROOT / ".env.example"


class TestComposeYaml:
    """Validate infra/compose.yaml structure and content."""

    def test_compose_file_exists(self) -> None:
        assert COMPOSE_FILE.exists(), "infra/compose.yaml must exist"

    def test_compose_is_valid_yaml(self) -> None:
        content = COMPOSE_FILE.read_text()
        parsed = yaml.safe_load(content)
        assert isinstance(parsed, dict), "compose.yaml must be a YAML mapping"

    def test_postgres_service_defined(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        services = parsed.get("services", {})
        assert "postgres" in services, "postgres service must be defined"

    def test_vault_service_defined(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        services = parsed.get("services", {})
        assert "vault" in services, "vault service must be defined"

    def test_postgres_uses_pgvector_image(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        pg = parsed["services"]["postgres"]
        assert "pgvector/pgvector:pg16" in pg.get("image", ""), (
            "postgres must use pgvector/pgvector:pg16 image"
        )

    def test_vault_uses_hashicorp_image(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        vault = parsed["services"]["vault"]
        assert vault.get("image", "").startswith("hashicorp/vault"), (
            "vault must use hashicorp/vault image"
        )

    def test_postgres_has_healthcheck(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        pg = parsed["services"]["postgres"]
        assert "healthcheck" in pg, "postgres must have a healthcheck"
        hc = pg["healthcheck"]
        # The test command should use pg_isready
        test_cmd = hc.get("test", "")
        if isinstance(test_cmd, list):
            test_cmd = " ".join(test_cmd)
        assert "pg_isready" in test_cmd, "postgres healthcheck must use pg_isready"

    def test_vault_has_healthcheck(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        vault = parsed["services"]["vault"]
        assert "healthcheck" in vault, "vault must have a healthcheck"

    def test_postgres_has_volume(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        pg = parsed["services"]["postgres"]
        assert "volumes" in pg, "postgres must have volumes defined"

    def test_services_share_network(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        # Either top-level networks are defined, or services use default network
        # Check that both services can communicate
        services = parsed["services"]
        pg_networks = set(services["postgres"].get("networks", []))
        vault_networks = set(services["vault"].get("networks", []))
        # If networks are explicitly defined, they must overlap
        if pg_networks and vault_networks:
            assert pg_networks & vault_networks, (
                "postgres and vault must share at least one network"
            )
        # If no explicit networks, docker compose default network handles it


class TestEnvExample:
    """Validate .env.example has all required variables."""

    REQUIRED_VARS = [
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
        "POSTGRES_DB",
        "PQDB_PLATFORM_DB",
        "VAULT_DEV_ROOT_TOKEN_ID",
        "VAULT_ADDR",
    ]

    def test_env_example_exists(self) -> None:
        assert ENV_EXAMPLE.exists(), ".env.example must exist"

    def test_env_example_has_required_vars(self) -> None:
        content = ENV_EXAMPLE.read_text()
        for var in self.REQUIRED_VARS:
            assert var in content, f".env.example must document {var}"

    def test_env_example_has_values(self) -> None:
        """Each variable should have an example value (not empty)."""
        content = ENV_EXAMPLE.read_text()
        for line in content.strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            assert "=" in line, f"Invalid line in .env.example: {line}"
            key, _, value = line.partition("=")
            assert value.strip(), f"{key} must have an example value"


class TestInitScripts:
    """Validate init scripts exist and are properly structured."""

    def test_db_init_script_exists(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-db.sh"
        assert script.exists(), "infra/init-scripts/init-db.sh must exist"

    def test_db_init_script_is_executable_shell(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-db.sh"
        content = script.read_text()
        assert content.startswith("#!/"), "init-db.sh must have a shebang line"

    def test_db_init_script_creates_platform_db(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-db.sh"
        content = script.read_text()
        assert "pqdb_platform" in content or "PQDB_PLATFORM_DB" in content, (
            "init-db.sh must reference the platform database"
        )

    def test_db_init_script_enables_pgvector(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-db.sh"
        content = script.read_text()
        assert "vector" in content.lower(), (
            "init-db.sh must enable the pgvector extension"
        )

    def test_vault_init_script_exists(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-vault.sh"
        assert script.exists(), "infra/init-scripts/init-vault.sh must exist"

    def test_vault_init_script_enables_transit(self) -> None:
        script = INFRA_DIR / "init-scripts" / "init-vault.sh"
        content = script.read_text()
        assert "transit" in content, (
            "init-vault.sh must enable the transit secrets engine"
        )

    def test_compose_mounts_db_init_script(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        pg = parsed["services"]["postgres"]
        volumes = pg.get("volumes", [])
        volume_str = str(volumes)
        assert "docker-entrypoint-initdb.d" in volume_str, (
            "postgres must mount init scripts to /docker-entrypoint-initdb.d/"
        )
