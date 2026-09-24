#!/bin/bash
# Compress a PDF locally with Ghostscript.
# Wraps the pdfwrite device with the settings that actually work on modern
# Ghostscript (10.x): plain presets often do NOTHING because Downsample*Images
# defaults to false and the 1.5 downsample threshold blocks mild reductions.
#
# Usage:
#   compress.sh <in.pdf> <out.pdf> [mode]
#
# Modes (default: auto):
#   auto            pick a sensible DPI from the source file size
#   screen|ebook|printer|prepress
#                   Acrobat-style preset; forced downsample is always applied
#   dpi=N           custom target resolution in DPI (50-400)
#   max=SIZE        iterate quality downwards until result is <= SIZE
#                   (SIZE: e.g. 5m, 800k, 300000)
#
# Examples:
#   compress.sh scan.pdf scan_small.pdf dpi=120
#   compress.sh report.pdf report_email.pdf max=2m
#   compress.sh book.pdf book_print.pdf prepress
set -u

GS_BIN="${GS_BIN:-gs}"
INPUT="$1"; OUTPUT="$2"; MODE="${3:-auto}"

if ! command -v "$GS_BIN" >/dev/null 2>&1; then
  echo "ERRORE: Ghostscript non trovato. Installalo con: brew install ghostscript" >&2
  exit 1
fi
if [ ! -f "$INPUT" ]; then
  echo "ERRORE: file non trovato: $INPUT" >&2
  exit 1
fi
if [ "$INPUT" = "$OUTPUT" ]; then
  echo "ERRORE: input e output devono essere file diversi" >&2
  exit 1
fi

orig_size=$(stat -f%z "$INPUT")

# ---------- helpers ----------
bytes() { # 5m -> 5242880 ; 800k -> 819200
  local v=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  case "$v" in
    *m) echo $(( ${v%m} * 1024 * 1024 )) ;;
    *k) echo $(( ${v%k} * 1024 )) ;;
    *)  echo "$v" ;;
  esac
}

compress_at() { # $1 = dpi, $2 = out file
  "$GS_BIN" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 \
    -dNOPAUSE -dQUIET -dBATCH \
    -dDownsampleColorImages=true -dDownsampleGrayImages=true \
    -dColorImageDownsampleThreshold=1.0 -dGrayImageDownsampleThreshold=1.0 \
    -dAutoFilterColorImages=false -dColorImageFilter=/DCTEncode \
    -dColorImageResolution="$1" -dGrayImageResolution="$1" \
    -dColorImageDownsampleType=/Bicubic -dGrayImageDownsampleType=/Bicubic \
    -sOutputFile="$2" "$INPUT" 2>/dev/null
}

preset_dpi() { # map preset name -> dpi used by the forced-downsample recipe
  case "$1" in
    screen)    echo 72 ;;
    ebook)     echo 150 ;;
    printer)   echo 300 ;;
    prepress)  echo 400 ;;
    *)         echo 150 ;;
  esac
}

report() { # $1 = final file
  local new_size=$(stat -f%z "$1")
  local pct=0
  if [ "$orig_size" -gt 0 ]; then
    pct=$(awk -v o="$orig_size" -v n="$new_size" 'BEGIN{printf "%.0f", (1 - n/o) * 100}')
  fi
  echo "✓ $INPUT → $1"
  awk -v o="$orig_size" -v n="$new_size" 'BEGIN{
    printf "  prima: %.1f MB  dopo: %.1f MB  risparmio: %d%%\n", o/1048576, n/1048576, (1 - n/o)*100 }'
  # sanity check: PDF must render without errors
  if "$GS_BIN" -q -dNOPAUSE -dBATCH -sDEVICE=nullpage "$1" 2>&1 | grep -qi error; then
    echo "  ⚠ ATTENZIONE: il PDF compreso genera errori durante il rendering!" >&2
    exit 1
  fi
}

# ---------- mode dispatch ----------
case "$MODE" in
  auto)
    if   [ "$orig_size" -gt 10485760 ]; then DPI=90
    elif [ "$orig_size" -gt 4194304  ]; then DPI=100
    elif [ "$orig_size" -gt 1048576  ]; then DPI=120
    else DPI=150
    fi
    compress_at "$DPI" "$OUTPUT" && report "$OUTPUT"
    ;;
  screen|ebook|printer|prepress)
    DPI=$(preset_dpi "$MODE")
    compress_at "$DPI" "$OUTPUT" && report "$OUTPUT"
    ;;
  dpi=*)
    DPI="${MODE#dpi=}"
    case "$DPI" in
      ''|*[!0-9]*) echo "ERRORE: DPI non valido: $DPI" >&2; exit 1 ;;
    esac
    if [ "$DPI" -lt 50 ] || [ "$DPI" -gt 400 ]; then
      echo "ERRORE: DPI fuori range (50-400): $DPI" >&2; exit 1
    fi
    compress_at "$DPI" "$OUTPUT" && report "$OUTPUT"
    ;;
  max=*)
    TARGET=$(bytes "${MODE#max=}")
    [ "$TARGET" -gt 0 ] || { echo "ERRORE: dimensione target non valida" >&2; exit 1; }
    DPI=180
    while [ "$DPI" -ge 60 ]; do
      compress_at "$DPI" "$OUTPUT"
      if [ "$(stat -f%z "$OUTPUT")" -le "$TARGET" ]; then
        report "$OUTPUT"; exit 0
      fi
      echo "  ... $DPI dpi -> $(stat -f%z "$OUTPUT") byte, ancora sopra il target, scendo..."
      DPI=$(( DPI - 15 ))
    done
    echo "Raggiunta la minima qualità (60 dpi) senza centrare il target di $TARGET byte." >&2
    exit 1
    ;;
  *)
    echo "ERRORE: modalità sconosciuta: $MODE" >&2
    echo "Modalità: auto | screen | ebook | printer | prepress | dpi=N | max=SIZE" >&2
    exit 1
    ;;
esac