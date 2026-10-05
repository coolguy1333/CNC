FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 app && mkdir -p /data /app && chown app /data
WORKDIR /app
COPY server.py ./
COPY static ./static
# The build context may arrive with restrictive permissions; make the code readable by the non-root user.
RUN chmod -R a+rX /app
USER app
ENV DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT', '8080'), timeout=4)"
CMD ["python", "server.py"]
