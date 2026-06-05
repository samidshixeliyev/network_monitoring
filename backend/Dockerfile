FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        libpq-dev \
        gcc \
        libcap2-bin \
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
