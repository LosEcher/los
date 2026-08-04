// docker-bake.hcl — Multi-platform Docker build definition
//
// Used by CI to build and push los images for linux/amd64 and linux/arm64.
//
// Local usage:
//   docker buildx bake
//
// CI usage (push to GHCR):
//   docker buildx bake --push
//
// Single platform:
//   docker buildx bake --set "*.platform=linux/amd64"

group "default" {
  targets = ["los"]
}

variable "REGISTRY" {
  default = "ghcr.io"
}

// GHCR namespace is lowercased from the GitHub username (LosEcher → losecher).
// GitHub username: LosEcher — repo: los
variable "IMAGE_NAME" {
  default = "losecher/los"
}

variable "TAG" {
  default = "latest"
}

target "los" {
  context    = "."
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags       = ["${REGISTRY}/${IMAGE_NAME}:${TAG}"]
  
  annotations = [
    "org.opencontainers.image.source=https://github.com/LosEcher/los",
    "org.opencontainers.image.description=Lightweight Agent Execution + Memory Management Platform",
    "org.opencontainers.image.licenses=MIT",
  ]
}

// Additional target: tag with git SHA for immutable references
target "los-sha" {
  inherits = ["los"]
  tags     = ["${REGISTRY}/${IMAGE_NAME}:${TAG}", "${REGISTRY}/${IMAGE_NAME}:sha-${TAG}"]
}
