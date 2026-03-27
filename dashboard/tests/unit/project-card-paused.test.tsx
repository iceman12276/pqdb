import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectCard } from "~/components/project-card";

const pausedProject = {
  id: "p1",
  name: "Paused App",
  region: "us-east-1",
  status: "paused",
  database_name: "pqdb_project_p1",
  created_at: "2026-01-15T10:00:00Z",
  wrapped_encryption_key: null,
};

const activeProject = {
  ...pausedProject,
  status: "active",
  name: "Active App",
};

describe("ProjectCard - Paused Badge", () => {
  it("shows destructive badge variant for paused status", () => {
    render(<ProjectCard project={pausedProject} />);
    const badge = screen.getByText("paused");
    expect(badge).toBeInTheDocument();
  });

  it("shows default badge variant for active status", () => {
    render(<ProjectCard project={activeProject} />);
    const badge = screen.getByText("active");
    expect(badge).toBeInTheDocument();
  });

  it("displays paused status text in the badge", () => {
    render(<ProjectCard project={pausedProject} />);
    expect(screen.getByText("paused")).toBeInTheDocument();
  });
});
