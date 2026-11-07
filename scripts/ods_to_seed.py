#!/usr/bin/env python3
"""Convertit l'export AppSheet (.ods/.xlsx) en supabase/seed.sql.

Usage :  python3 scripts/ods_to_seed.py Stock_BdN.ods [supabase/seed.sql]
Dépendances : pip install pandas odfpy openpyxl
Les identifiants AppSheet (8 caractères hexa) sont conservés tels quels.
Le projecteur d'essai (IsTest = 1) est ignoré.
"""
import sys
import pandas as pd

src = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else "supabase/seed.sql"
engine = "odf" if src.lower().endswith(".ods") else None
x = pd.read_excel(src, engine=engine, sheet_name=None)

def q(v):
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return "null"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return str(int(v)) if float(v).is_integer() else str(v)
    if isinstance(v, pd.Timestamp):
        return "'" + v.strftime("%Y-%m-%d %H:%M:%S") + "+00'"
    return "'" + str(v).strip().replace("'", "''") + "'"

def ref(v):
    return "null" if (not isinstance(v, str) and pd.isna(v)) else q(v)

out = ["-- Données migrées depuis AppSheet (généré par scripts/ods_to_seed.py)", "begin;"]

def simple(sheet, table, cols, srccols):
    df = x[sheet].dropna(subset=[srccols[0]])
    for _, r in df.iterrows():
        vals = ", ".join(q(r[c]) for c in srccols)
        out.append(f"insert into {table} ({', '.join(cols)}) values ({vals}) on conflict (id) do nothing;")

simple("Familles", "families", ["id", "name"], ["ID_famille", "Famille"])
simple("Types", "item_types", ["id", "name"], ["ID_Type", "Type"])
simple("Douilles", "sockets", ["id", "name"], ["ID_Douille", "Douille"])
simple("PortesFiltres", "filter_sizes", ["id", "label", "sheets_lee", "sheets_rosco"],
       ["ID_PF", "Taille", "par Feuille LEE", "par Feuille ROSCO"])
simple("Lampes", "lamps", ["id", "name", "power_w", "temp_k", "socket_id"],
       ["ID_Lamp", "Lampe_base", "puissance W", "temp", "douille"])

m = x["Modèles"].dropna(subset=["ID_Model"])
for _, r in m.iterrows():
    out.append(
        "insert into models (id, name, family_id, type_id, filter_size_id, socket_id, notice_url) values ("
        + ", ".join(q(r[c]) for c in ["ID_Model", "Modèle_base", "Famille", "Type", "Taille PF", "Douille", "Notice"])
        + ") on conflict (id) do nothing;")

STATUS = {1: "dispo", 2: "sav", 3: "en_pret"}
s = x["stock v2"]
s = s[s["IsTest"].fillna(0) != 1]
for _, r in s.iterrows():
    when = r["proj_modifié le"] if pd.notna(r["proj_modifié le"]) else (
        r["proj_créé le"] if pd.notna(r["proj_créé le"]) else pd.Timestamp("2025-07-07"))
    created = r["proj_créé le"] if pd.notna(r["proj_créé le"]) else pd.Timestamp("2025-07-07")
    last = r["dernier SAV"]
    last_sql = "null" if pd.isna(last) else "'" + pd.Timestamp(last).strftime("%Y-%m-%d") + "'"
    out.append(
        "insert into items (id, model_id, lamp_id, status, status_at, last_service, created_at) overriding system value values ("
        f"{int(r['Item_ID'])}, {q(r['Modèle'])}, {ref(r['Lampe'])}, '{STATUS[int(r['état'])]}', {q(when)}, {last_sql}, {q(created)}"
        ") on conflict (id) do nothing;")
out.append("select setval(pg_get_serial_sequence('items','id'), (select max(id) from items));")

ids = set(int(i) for i in s["Item_ID"])
for _, r in x["Liste pannes"].dropna(subset=["ID_panne"]).iterrows():
    if int(r["Objet concerné"]) not in ids:
        continue
    out.append(
        "insert into faults (item_id, description, reported_by_label) values ("
        f"{int(r['Objet concerné'])}, {q(r['descriptif'])}, {q(r['signalé par'])});")

out.append("commit;")
open(dst, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"{dst} : {len(out)} lignes, {len(s)} projecteurs")
