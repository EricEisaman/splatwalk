#!/bin/sh
set -e

# Set default PORT to 80 if not provided (for local testing)
# Render.com will always provide PORT environment variable
export PORT=${PORT:-80}

# nginx:alpine's /docker-entrypoint.sh automatically processes templates
# in /etc/nginx/templates/ and substitutes environment variables
# Since we've set PORT above, it will be available for substitution
# Execute nginx:alpine's default entrypoint which handles template processing
exec /docker-entrypoint.sh "$@"

