import os
import re

import psycopg2

schema = os.environ["POSTGRES_SCHEMA"]
if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
    raise SystemExit(f"POSTGRES_SCHEMA must be a plain lowercase identifier, got {schema!r}")

conn = psycopg2.connect(
    host=os.environ["DB_HOST"],
    port=os.environ["DB_PORT"],
    dbname=os.environ["POSTGRES_DB"],
    user=os.environ["POSTGRES_USER"],
    password=os.environ["POSTGRES_PASSWORD"],
)
conn.autocommit = True
with conn.cursor() as cur:
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
    cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
conn.close()
print(f"rag-prestart: pgvector and schema {schema} ready")
