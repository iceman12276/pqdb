"""Unit tests for the Project model."""

import uuid

from pqdb_api.models.project import Project


class TestProjectModel:
    """Tests for Project SQLAlchemy model."""

    def test_table_name(self) -> None:
        assert Project.__tablename__ == "projects"

    def test_columns_exist(self) -> None:
        columns = {c.name for c in Project.__table__.columns}
        expected = {
            "id",
            "developer_id",
            "name",
            "region",
            "status",
            "created_at",
        }
        assert columns == expected

    def test_id_is_primary_key(self) -> None:
        pk_cols = [c.name for c in Project.__table__.primary_key]
        assert pk_cols == ["id"]

    def test_developer_id_is_foreign_key(self) -> None:
        col = Project.__table__.columns["developer_id"]
        fk_targets = [fk.target_fullname for fk in col.foreign_keys]
        assert "developers.id" in fk_targets

    def test_name_is_not_nullable(self) -> None:
        col = Project.__table__.columns["name"]
        assert col.nullable is False

    def test_status_defaults_to_active(self) -> None:
        project = Project(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            name="test-project",
        )
        assert project.status == "active"

    def test_region_defaults_to_us_east_1(self) -> None:
        project = Project(
            id=uuid.uuid4(),
            developer_id=uuid.uuid4(),
            name="test-project",
        )
        assert project.region == "us-east-1"

    def test_can_instantiate(self) -> None:
        proj_id = uuid.uuid4()
        dev_id = uuid.uuid4()
        project = Project(
            id=proj_id,
            developer_id=dev_id,
            name="my-project",
            region="eu-west-1",
            status="active",
        )
        assert project.id == proj_id
        assert project.developer_id == dev_id
        assert project.name == "my-project"
        assert project.region == "eu-west-1"
        assert project.status == "active"
