#!/usr/bin/env bash
# Push the current code to the GCP VM and restart the service. Usage: ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy.env ] || { echo "deploy.env missing (see README: Deployed)" >&2; exit 1; }
source deploy.env # P (project), Z (zone), VM (user@vm-name); gitignored
tar --exclude=node_modules --exclude=data --exclude=.playwright-mcp --exclude=.DS_Store -czf /tmp/bt.tgz *.js package.json package-lock.json public README.md
gcloud compute scp /tmp/bt.tgz $VM:~/bt.tgz --zone=$Z --project=$P --quiet
gcloud compute ssh $VM --zone=$Z --project=$P --quiet --command='source ~/.nvm/nvm.sh && tar xzf ~/bt.tgz -C ~/bettertransit && rm ~/bt.tgz && cd ~/bettertransit && npm ci --omit=dev --silent && sudo systemctl restart bettertransit && sleep 20 && systemctl is-active bettertransit'
