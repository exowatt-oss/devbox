#!/bin/sh

forward_arg=''
for arg in "$@"; do
  case "$arg" in
    *fail.example*)
      echo 'fake ssh connection failure' >&2
      exit 23
      ;;
    *127.0.0.1:*:*)
      forward_arg="$arg"
      ;;
    *hang*)
      sleep 60
      exit 0
      ;;
  esac
done

if [ -n "$forward_arg" ]; then
  local_port=$(printf '%s' "$forward_arg" | cut -d: -f2)
  exec node --input-type=module -e '
    import { createServer } from "node:net"
    const port = Number(process.argv.at(-1))
    const server = createServer()
    server.listen(port, "127.0.0.1")
    const stop = () => server.close(() => process.exit(0))
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
  ' "$local_port"
fi

last=''
for arg in "$@"; do
  last="$arg"
done
if [ "$last" = 'bash -s' ]; then
  cat >/dev/null
  printf 'script-output\n'
else
  printf 'command-output\n'
fi
