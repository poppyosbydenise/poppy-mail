#!/bin/bash
# Double-click this file to start Denise Mail. It opens in your web browser.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Denise Mail needs Python 3, which is not installed on this computer."
  echo "Get it from https://www.python.org/downloads/ and try again."
  read -r -p "Press Return to close."
  exit 1
fi
python3 denise_mail.py
echo
read -r -p "Denise Mail has stopped. Press Return to close this window."
