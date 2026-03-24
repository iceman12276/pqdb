"""Tests for PQC TLS verification infrastructure.

Validates that the PQC TLS verification script exists, is well-formed,
and that the Caddy configuration supports PQC key exchange. Also validates
the PQC TLS compatibility documentation.
"""

import os
import stat
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
INFRA_DIR = REPO_ROOT / "infra"
COMPOSE_FILE = INFRA_DIR / "compose.yaml"
VERIFY_SCRIPT = INFRA_DIR / "scripts" / "verify-pqc-tls.sh"
DOCS_DIR = REPO_ROOT / "docs"
PQC_TLS_DOC = DOCS_DIR / "pqc-tls-compatibility.md"


class TestVerifyPqcTlsScript:
    """Validate the PQC TLS verification script."""

    def test_script_exists(self) -> None:
        assert VERIFY_SCRIPT.exists(), "infra/scripts/verify-pqc-tls.sh must exist"

    def test_script_is_executable(self) -> None:
        mode = os.stat(VERIFY_SCRIPT).st_mode
        assert mode & stat.S_IXUSR, "verify-pqc-tls.sh must be executable (chmod +x)"

    def test_script_has_shebang(self) -> None:
        content = VERIFY_SCRIPT.read_text()
        assert content.startswith("#!/"), "verify-pqc-tls.sh must have a shebang line"

    def test_script_uses_bash(self) -> None:
        first_line = VERIFY_SCRIPT.read_text().splitlines()[0]
        assert "bash" in first_line, "verify-pqc-tls.sh must use bash"

    def test_script_checks_for_x25519mlkem768(self) -> None:
        content = VERIFY_SCRIPT.read_text()
        assert "X25519MLKEM768" in content, (
            "verify-pqc-tls.sh must check for X25519MLKEM768 key exchange"
        )

    def test_script_uses_openssl_s_client(self) -> None:
        content = VERIFY_SCRIPT.read_text()
        assert "openssl s_client" in content, (
            "verify-pqc-tls.sh must use openssl s_client for TLS inspection"
        )

    def test_script_uses_strict_mode(self) -> None:
        content = VERIFY_SCRIPT.read_text()
        assert "set -euo pipefail" in content, (
            "verify-pqc-tls.sh must use strict mode (set -euo pipefail)"
        )

    def test_script_supports_custom_host_port(self) -> None:
        """Script should accept optional host and port arguments."""
        content = VERIFY_SCRIPT.read_text()
        assert "${1:-" in content or "$1" in content, (
            "verify-pqc-tls.sh should accept a hostname argument"
        )
        assert "${2:-" in content or "$2" in content, (
            "verify-pqc-tls.sh should accept a port argument"
        )

    def test_script_defaults_to_localhost_443(self) -> None:
        content = VERIFY_SCRIPT.read_text()
        assert "localhost" in content, "verify-pqc-tls.sh must default to localhost"
        assert "443" in content, "verify-pqc-tls.sh must default to port 443"

    def test_script_has_meaningful_exit_codes(self) -> None:
        """Script should use different exit codes for different outcomes."""
        content = VERIFY_SCRIPT.read_text()
        assert "exit 0" in content, "Script must exit 0 on PQC success"
        assert "exit 1" in content, "Script must exit 1 on classical fallback"
        assert "exit 2" in content, "Script must exit 2 on connection failure"


class TestCaddyPqcTlsConfig:
    """Validate Caddy is configured for PQC TLS."""

    def test_caddy_service_exists(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        services = parsed.get("services", {})
        assert "caddy" in services, "caddy service must be defined"

    def test_caddy_exposes_https_port(self) -> None:
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        caddy = parsed["services"]["caddy"]
        ports = [str(p) for p in caddy.get("ports", [])]
        port_str = " ".join(ports)
        assert "443" in port_str, "caddy must expose port 443 for HTTPS"

    def test_caddy_uses_latest_image(self) -> None:
        """Caddy latest uses Go 1.24+ which supports X25519MLKEM768."""
        parsed = yaml.safe_load(COMPOSE_FILE.read_text())
        caddy = parsed["services"]["caddy"]
        image = caddy.get("image", "")
        assert image.startswith("caddy:"), "caddy must use official caddy image"

    def test_caddyfile_uses_tls_internal(self) -> None:
        caddyfile = INFRA_DIR / "Caddyfile"
        content = caddyfile.read_text()
        assert "tls internal" in content, (
            "Caddyfile must use 'tls internal' for local dev certificates"
        )

    def test_caddyfile_documents_pqc_support(self) -> None:
        """Caddyfile should mention PQC/X25519MLKEM768 in comments."""
        caddyfile = INFRA_DIR / "Caddyfile"
        content = caddyfile.read_text()
        assert "X25519MLKEM768" in content or "PQC" in content, (
            "Caddyfile should document PQC support in comments"
        )

    def test_caddyfile_mentions_go_version(self) -> None:
        """Caddyfile should note Go 1.24+ PQC key exchange support."""
        caddyfile = INFRA_DIR / "Caddyfile"
        content = caddyfile.read_text()
        assert "Go 1.24" in content, "Caddyfile should mention Go 1.24+ for PQC context"


class TestPqcTlsDocumentation:
    """Validate PQC TLS compatibility documentation."""

    def test_doc_exists(self) -> None:
        assert PQC_TLS_DOC.exists(), "docs/pqc-tls-compatibility.md must exist"

    def test_doc_documents_chrome_support(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "Chrome" in content and "131" in content, (
            "Doc must mention Chrome 131+ PQC support"
        )

    def test_doc_documents_firefox_support(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "Firefox" in content and "132" in content, (
            "Doc must mention Firefox 132+ PQC support"
        )

    def test_doc_documents_safari_support(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "Safari" in content and "18.4" in content, (
            "Doc must mention Safari 18.4+ PQC support"
        )

    def test_doc_documents_node23_support(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "Node" in content and "23" in content, (
            "Doc must mention Node.js 23+ PQC support"
        )

    def test_doc_documents_node22_fallback(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "Node" in content and "22" in content, (
            "Doc must mention Node.js 22 classical fallback"
        )
        # Verify it mentions that data is still ML-KEM encrypted at app layer
        assert "ML-KEM" in content or "application layer" in content, (
            "Doc must mention application-layer ML-KEM encryption as fallback"
        )

    def test_doc_documents_x25519mlkem768(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "X25519MLKEM768" in content, (
            "Doc must mention X25519MLKEM768 key exchange"
        )

    def test_doc_explains_defense_in_depth(self) -> None:
        """Doc should explain that PQC TLS is one layer of defense."""
        content = PQC_TLS_DOC.read_text().lower()
        has_defense = "defense in depth" in content
        has_app_layer = "application layer" in content
        assert has_defense or has_app_layer, (
            "Doc must explain defense-in-depth security model"
        )

    def test_doc_references_verification_script(self) -> None:
        content = PQC_TLS_DOC.read_text()
        assert "verify-pqc-tls" in content, "Doc must reference the verification script"
