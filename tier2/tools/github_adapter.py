"""GitHub-shaped adapter over Gitea REST — production GitHub is a base-URL +
token swap (identical endpoints used: repos, contents, pulls)."""

from __future__ import annotations

import base64
import os
import time

import httpx

from .workspace import PROJECT, changed_files


class GitHubAdapter:
    """The subset of the GitHub REST v3 surface the pipeline needs; Gitea
    implements the same paths."""

    def __init__(self, base_url: str, auth: tuple[str, str] | str):
        headers = {}
        basic = None
        if isinstance(auth, str):
            headers["Authorization"] = f"token {auth}"
        else:
            basic = auth
        self.http = httpx.Client(base_url=base_url.rstrip("/") + "/api/v1",
                                 headers=headers, auth=basic, timeout=30)

    def ensure_repo(self, name: str) -> dict:
        """The repo must hold the baseline: gitea-init.sh pushes the baked
        checkout as `main` + tag sojourner-base. An auto-initialised repo would
        give every PR an unrelated history, so a missing repo is an error."""
        r = self.http.get(f"/repos/{self._owner}/{name}")
        if r.status_code == 404:
            raise RuntimeError(f"gitea has no {self._owner}/{name} — run make demo2-up "
                               "(gitea-init.sh pushes the baseline)")
        r.raise_for_status()
        return r.json()

    @property
    def _owner(self) -> str:
        return os.environ.get("GITEA_USER", "sojourner-ops")

    def create_branch(self, repo: str, branch: str, from_branch: str = "main") -> None:
        r = self.http.post(f"/repos/{self._owner}/{repo}/branches",
                           json={"new_branch_name": branch,
                                 "old_branch_name": from_branch})
        if r.status_code not in (201, 409):
            r.raise_for_status()

    def upsert_file(self, repo: str, branch: str, path: str, content: str,
                    message: str) -> None:
        b64 = base64.b64encode(content.encode()).decode()
        get = self.http.get(f"/repos/{self._owner}/{repo}/contents/{path}",
                            params={"ref": branch})
        if get.status_code == 200:
            body = {"content": b64, "message": message, "branch": branch,
                    "sha": get.json()["sha"]}
            r = self.http.put(f"/repos/{self._owner}/{repo}/contents/{path}", json=body)
        else:
            body = {"content": b64, "message": message, "branch": branch}
            r = self.http.post(f"/repos/{self._owner}/{repo}/contents/{path}", json=body)
        r.raise_for_status()

    def create_pull(self, repo: str, head: str, base: str, title: str,
                    body: str) -> dict:
        r = self.http.post(f"/repos/{self._owner}/{repo}/pulls",
                           json={"head": head, "base": base, "title": title,
                                 "body": body})
        r.raise_for_status()
        return r.json()


def gitea_pr(summary: str, detail: str = "") -> dict:
    gh = GitHubAdapter(
        os.environ.get("GITEA_URL", "http://gitea:3000"),
        (os.environ.get("GITEA_USER", "sojourner-ops"),
         os.environ["GITEA_PASSWORD"]))
    repo = os.environ.get("GITEA_REPO", "new-horizons")
    branch = f"change/{int(time.time())}"
    gh.ensure_repo(repo)
    gh.create_branch(repo, branch)

    # The PR carries the REAL diff: every file the tier-1 developer's commits
    # touched, pushed through the same contents API GitHub exposes.
    changed = changed_files()
    pushed, skipped = [], []
    for rel in changed:
        path = PROJECT / rel
        if not path.is_file():
            skipped.append({"path": rel, "reason": "deleted or missing"})
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            skipped.append({"path": rel, "reason": "binary"})
            continue
        gh.upsert_file(repo, branch, rel, content, f"{summary} [{rel}]")
        pushed.append(rel)

    gh.upsert_file(repo, branch, "CHANGELOG.md",
                   f"# Change\n\n{summary}\n\n{detail}\n", f"docs: {summary}")
    body = detail or summary
    if pushed:
        body += "\n\nFiles changed by the tier-1 developer agent:\n" + \
                "\n".join(f"- `{f}`" for f in pushed)
    pr = gh.create_pull(repo, head=branch, base="main", title=summary,
                        body=body)
    return {"pr_number": pr.get("number"), "pr_url": pr.get("html_url"),
            "branch": branch, "repo": repo, "files_pushed": pushed,
            "files_skipped": skipped}
