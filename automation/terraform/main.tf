resource "github_repository" "managed" {
  for_each = var.repositories

  name               = each.key
  description        = each.value.description
  visibility         = each.value.visibility
  topics             = each.value.topics
  auto_init          = each.value.template == null
  archive_on_destroy = true

  dynamic "template" {
    for_each = each.value.template == null ? [] : [each.value.template]
    content {
      owner      = template.value.owner
      repository = template.value.repository
    }
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes = [
      auto_init,
      template,
      allow_merge_commit,
      allow_rebase_merge,
      allow_squash_merge,
      merge_commit_message,
      merge_commit_title,
      squash_merge_commit_message,
      squash_merge_commit_title,
    ]
  }
}

resource "github_branch_default" "managed" {
  for_each = var.repositories

  repository      = github_repository.managed[each.key].name
  branch          = "main"
  rename          = true
  wait_for_rename = true
}

resource "github_repository_collaborators" "managed" {
  for_each = var.repositories

  repository = github_repository.managed[each.key].name

  dynamic "user" {
    for_each = each.value.users
    content {
      username   = user.key
      permission = user.value
    }
  }

  dynamic "team" {
    for_each = each.value.teams
    content {
      team_id    = team.key
      permission = team.value
    }
  }
}

resource "github_repository_ruleset" "managed" {
  for_each = var.repositories

  name        = "review-default-branch"
  repository  = github_repository.managed[each.key].name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  rules {
    deletion         = true
    non_fast_forward = true

    dynamic "pull_request" {
      for_each = var.require_pull_request_reviews ? [true] : []
      content {
        required_approving_review_count = 1
        dismiss_stale_reviews_on_push   = true
        require_last_push_approval      = true
      }
    }
  }

  depends_on = [github_branch_default.managed, github_repository_collaborators.managed]
}
