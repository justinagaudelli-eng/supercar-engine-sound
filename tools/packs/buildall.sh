#!/bin/zsh
# Rebuild recorded packs from the Commons recordings (see README.md in this folder).
# usage: tools/packs/buildall.sh <outdir> [car...]     e.g. tools/packs/buildall.sh /tmp/packs svj gt3rs
D=${0:A:h}; out=${1:?outdir}; shift
typeset -A SPEC
SPEC[svj]="12 950 8700 zqv9zLtHsUM qll6WBfaXvM oMKxhIcSmZs"
SPEC[sto]="10 1000 8500 QsDJ3Y7k4qg p4F3h9Q5Lpo"
SPEC[temerario]="8 1000 10000 iSInroGsLfU"
SPEC[765lt]="8 1000 8500 5oSRv66QFW0 RXj9PUkF0gk XfgPgX7KNg"
SPEC[turbos]="6 950 7200 8tknvHMRiLQ 4lUxNn0D9Nw dSxwdW02c2M"
SPEC[gt3rs]="6 950 9000 1t2wz1iLHJ4 hpwTF8TXcaA otznJ2rBoks"
cars=("$@"); [[ $# -eq 0 ]] && cars=(${(k)SPEC})
for id in $cars; do
  set -- ${=SPEC[$id]}; n=$1 idle=$2 red=$3; shift 3
  files=(); for k in "$@"; do [[ -s $D/rec/$k.opus ]] && files+=($D/rec/$k.opus); done
  echo "===== $id (${#files} recordings)"
  python3 -P $D/extract.py $id $n $idle $red $out/$id $files
done
