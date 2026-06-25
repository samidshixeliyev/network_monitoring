FROM python:3.12-slim

WORKDIR /app

# ── Microsoft ODBC Driver 18 for SQL Server + build deps ────────────────────
# Needed by pyodbc/aioodbc to talk to MSSQL. msodbcsql18 comes from Microsoft's
# apt repo. CAP_NET_RAW (libcap2-bin) is still needed for icmplib raw sockets.
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl gnupg ca-certificates \
        gcc g++ unixodbc-dev \
        libcap2-bin iputils-ping \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
        | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
        > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Grant CAP_NET_RAW to the Python interpreter so the non-root user can send
# raw ICMP sockets (required by icmplib). The container must also have
# cap_add: [NET_RAW] in docker-compose (already set).
RUN setcap cap_net_raw+ep $(readlink -f $(which python3))

# Non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
