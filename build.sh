#!/usr/bin/env bash
# Render build command. In the Render dashboard set:
#   Build Command:  ./build.sh
# (or paste these two lines directly).
set -e
pip install -r requirements.txt
# Download the Chromium binary Playwright needs — WITHOUT this the API renders
# nothing ("Executable doesn't exist ... playwright install"). Installing just
# chromium keeps the build small.
python -m playwright install chromium
