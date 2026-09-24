---
name: pdf-compress
description: 'Comprime PDF in locale con Ghostscript (nessun upload online). Copre file scansionati (es. ML Kit / app scanner), documenti con foto e contratti: preset di qualità, DPI personalizzato o target di dimensione massimo con iterazione automatica. Usa quando devi ridurre le dimensioni di uno o più PDF, renderli leggeri per email/upload, o confrontare qualità e dimensione. Verifica prerequisiti e usa scripts/compress.sh. Richiede Ghostscript (brew install ghostscript).'
---

# PDF Compression (locale, Ghostscript)

Comprime file PDF interamente sul Mac con Ghostscript (`pdfwrite`).
Nessun dato lascia la macchina — a differenza dei servizi web di compressione.

## Prerequisiti

```bash
brew install ghostscript   # se `gs --version` fallisce
```

## Uso rapido

```bash
# Compresso intelligente (scala i DPI in base alla dimensione sorgente)
./scripts/compress.sh input.pdf output.pdf

# Qualità controllata
./scripts/compress.sh input.pdf output.pdf dpi=120
./scripts/compress.sh input.pdf output.pdf ebook
./scripts/compress.sh input.pdf output.pdf screen

# Target di dimensione: parte da 180 dpi e scende finché non ci sta
./scripts/compress.sh input.pdf output.pdf max=2m      # max 2 MB
./scripts/compress.sh input.pdf output.pdf max=800k    # max 800 KB
```

Più file: `for f in *.pdf; do ./scripts/compress.sh "$f" "${f%.pdf}_min.pdf"; done`

## Guida alla qualità (DPI di ricampionamento immagini)

| DPI | Uso | Effetto tipico |
|---|---|---|
| 300 | stampa / archivio | −10–30% |
| 150 (`ebook`) | buona qualità, email | −30–60% |
| 120 | scansioni di testo (consigliato) | −60–70% |
| 100 | solo schermo | −70–80% |
| 72 (`screen`) | anteprima, invio veloce | −80%+ |

Il testo vettoriale (PDF nativi, contratti) resta **perfettamente nitido** a
qualsiasi DPI: i DPI agiscono solo sulle immagini raster.

## Conoscenze critiche (trabocchetti Ghostscript 10.x)

1. **`-dPDFSETTINGS=/ebook` da solo spesso NON comprime nulla.** In GS 10.x
   `-dDownsampleColorImages` è `false` di default: senza preset (o senza flag
   espliciti) le immagini JPEG passano invariate. Il preset lo attiva, ma...
2. **Soglia di downsampling 1.5:** `/ebook` (150 dpi) non tocca immagini già
   vicine ai 150–175 dpi (scansioni da ML Kit / Google Drive sono ~175 dpi):
   rapporto 175/150 = 1.17 < 1.5 → nessun ricampionamento, nessun risparmio.
   Lo script forza `-dColorImageDownsampleThreshold=1.0` per aggirare il blocco.
3. **Scala realisticamente:** scansioni già compresse da app scanner hanno
   margini limitati; il grosso del risparmio è su foto ad alta risoluzione
   (es. foto da telefono ~300 dpi in contratti) o PDF mai ottimizzati.
4. Ghostscript di default gira in `SAFER` mode: accessi file da `-c` falliscono
   senza `-dNOSAFER`.

## Diagnostica

```bash
# Conteggio pagine (Spotlight)
mdls -raw -name kMDItemNumberOfPages file.pdf

# Dimensioni native dei JPEG incorporati (marker SOF, zero dipendenze)
python3 - <<'EOF'
from pathlib import Path; import struct
data = Path("file.pdf").read_bytes(); i = 0
while True:
    i = data.find(b'\xff\xd8', i)
    if i < 0: break
    j = i + 2; k = j; sof = None
    while k < len(data) - 1:
        if data[k] != 0xff: k += 1; continue
        m = data[k+1]
        if m in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
            sof = struct.unpack('>HH', data[k+5:k+9]); break
        if m == 0xda: break
        if m in (0xd0,0xd1,0xd2,0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0x01): k += 2; continue
        k += 2 + struct.unpack('>H', data[k+2:k+4])[0]
    print("JPEG SOF WxH:", sof, "(dpi ≈ larghezza / larghezza pagina in pollici)") ; i = j
EOF

# Verifica integrità del file compresso (0 errori = ok)
gs -q -dNOPAUSE -dBATCH -sDEVICE=nullpage output.pdf 2>&1 | grep -ci error
```

Le dimensioni native dei JPEG + la dimensione pagina (es. A4 = 8.27 in) danno i
DPI effettivi: `dpi ≈ px / pollici`. Se i DPI nativi sono già bassi (≤120),
usa `screen` o accetta risparmi modesti.

Dopo la compressione **confronta sempre** prima/dopo e valida l'output:
lo script lo fa automaticamente e stampa il risparmio percentuale.

## Limitazioni note

- Scansioni b/n già ottimizzate (JBIG2/CCITT) e PDF vettoriali puri si
  comprimono poco: il guadagno sta nelle immagini raster ad alta risoluzione.
- La modalità `max=` può arrivare a 60 dpi se il target è irrealistico:
  in tal caso riporta un errore esplicito invece di produrre qualità inaccettabile.
- Per PDF protetti da password servono prima strumenti dedicati (qpdf).