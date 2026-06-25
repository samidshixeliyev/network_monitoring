"""
Create the target database if it does not exist (connects to `master` first).
Used by the Docker lab where a fresh MSSQL container starts with no DB yet.
Reads the same MSSQL_* env vars as the app.
"""
import os

import pyodbc

driver = os.getenv("MSSQL_DRIVER", "ODBC Driver 18 for SQL Server")
server = os.getenv("MSSQL_SERVER", "mssql")
user = os.getenv("MSSQL_USER", "sa")
password = os.getenv("MSSQL_PASSWORD", "")
database = os.getenv("MSSQL_DATABASE", "network")

conn_str = (
    f"DRIVER={{{driver}}};SERVER={server};DATABASE=master;"
    f"UID={user};PWD={password};Encrypt=yes;TrustServerCertificate=yes;"
)

conn = pyodbc.connect(conn_str, autocommit=True)
conn.execute(f"IF DB_ID(N'{database}') IS NULL CREATE DATABASE [{database}]")
print(f"[create_db] database ready: {database}")
conn.close()
