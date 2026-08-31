terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Recommended: use a remote backend for team use / CI. Example (uncomment
  # and fill in a pre-created S3 bucket + DynamoDB lock table):
  #
  # backend "s3" {
  #   bucket         = "ecom-terraform-state"
  #   key            = "ecom-3tier/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "ecom-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.aws_region
}
