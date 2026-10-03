#!/bin/sh
set -eu
install -m 755 bin/notes /usr/local/bin/notes
notes --help >/dev/null
