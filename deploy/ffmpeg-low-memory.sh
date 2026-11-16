#!/bin/sh
# Bound codec and filter threads for the app and Hypit providers alike.
set -eu
case "${1:-}" in -version|-h|--help|-formats|-filters|-codecs|-encoders|-decoders) exec /usr/bin/ffmpeg "$@";; esac
if [ "$#" -eq 0 ]; then exec /usr/bin/ffmpeg; fi
first=1
previous=
for argument do
  if [ "$first" -eq 1 ]; then set --; first=0; else set -- "$@" "$previous"; fi
  previous=$argument
done
exec /usr/bin/ffmpeg -threads 1 -filter_threads 1 -filter_complex_threads 1 "$@" -threads 1 "$previous"
