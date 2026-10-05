FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 app && mkdir -p /data /app && chown app /data
WORKDIR /app
COPY server.py ./
COPY static ./static
USER app
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["python", "server.py"]
