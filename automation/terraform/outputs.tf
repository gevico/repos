output "repositories" {
  value = {
    for name, repository in github_repository.managed : name => {
      id  = repository.repo_id
      url = repository.html_url
    }
  }
}
