#!/bin/sh
# usage: fetch.sh <name> <url>  -> saves _raw/pages/<name>.html and <name>.txt (tag-stripped)
name="$1"; url="$2"
curl -sL --max-time 40 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" -o "$name.html" -w "%{http_code} %{size_download} $name\n" "$url"
python - "$name" <<'PY'
import sys,re,html
n=sys.argv[1]
s=open(n+".html",encoding="utf-8",errors="ignore").read()
s=re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>"," ",s)
s=re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>|</tr>","\n",s)
s=re.sub(r"<[^>]+>"," ",s)
s=html.unescape(s)
s=re.sub(r"[ \t\r\f\v]+"," ",s)
s=re.sub(r"\n\s*\n+","\n",s)
open(n+".txt","w",encoding="utf-8").write(s)
PY
