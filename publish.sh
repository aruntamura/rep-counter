#!/usr/bin/env bash
# One-time setup: creates github.com/aruntamura/rep-counter, pushes this folder,
# and turns on GitHub Pages so the phone app goes live.
#
#   bash publish.sh
#
# Needs the GitHub CLI. On a Mac: brew install gh   (other systems: https://cli.github.com)
set -euo pipefail

OWNER="aruntamura"
REPO="rep-counter"
cd "$(dirname "$0")"

if ! command -v gh >/dev/null 2>&1; then
  echo "This needs the GitHub CLI. On a Mac: brew install gh   (other systems: https://cli.github.com)"
  exit 1
fi

# 1. Log in to GitHub. The first time, this opens your browser to authorize.
if ! gh auth status >/dev/null 2>&1; then
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git >/dev/null 2>&1 || true   # lets git push with the same login

# 2. Make the first commit.
[ -d .git ] || git init -q
if [ -z "$(git config user.email || true)" ]; then
  git config user.name "Arun Tamura"
  git config user.email "$OWNER@users.noreply.github.com"
fi
git add -A
git commit -qm "Rep counter: Python pipeline and phone app" || echo "(nothing new to commit)"
git branch -M main

# 3. Create the repository on GitHub and push.
if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "github.com/$OWNER/$REPO already exists, so pushing to it."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push -u origin main
else
  gh repo create "$OWNER/$REPO" --public --source=. --remote=origin --push \
    --description "Counts workout reps from a phone's accelerometer (EE 102A final project)"
fi

# 4. Turn on GitHub Pages, serving the app from the docs/ folder.
if gh api -X POST "repos/$OWNER/$REPO/pages" -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1; then
  echo "GitHub Pages is on."
else
  echo "Couldn't turn on Pages automatically (it may already be on). Check it here:"
  echo "  https://github.com/$OWNER/$REPO/settings/pages   (Deploy from a branch, main, /docs)"
fi

echo
echo "Repository: https://github.com/$OWNER/$REPO"
echo "Phone app:  https://$OWNER.github.io/$REPO/   (live in a minute or two)"
