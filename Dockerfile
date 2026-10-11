FROM node:20-slim AS web-build
WORKDIR /web
COPY product/entrypoints/web/package*.json ./
RUN npm install
COPY product/entrypoints/web ./
RUN npm run build

FROM python:3.11-slim

WORKDIR /app

COPY product/entrypoints/http-api/requirements.txt /app/product/entrypoints/http-api/requirements.txt
RUN pip install --no-cache-dir -r /app/product/entrypoints/http-api/requirements.txt

COPY product/modules /app/product/modules
COPY product/shared-kernel /app/product/shared-kernel
COPY product/entrypoints/http-api /app/product/entrypoints/http-api
COPY --from=web-build /web/dist /app/product/entrypoints/web/dist
COPY ui-screens/index.html /app/ui-screens/index.html
COPY ui-screens/preview.html /app/ui-screens/preview.html
COPY ui-screens/lms_widget.html /app/ui-screens/lms_widget.html
COPY ui-screens/lms_ui_viewer.html /app/ui-screens/lms_ui_viewer.html

ENV CRUCIBLE_HOST=0.0.0.0 \
    CRUCIBLE_COOKIE_SECURE=true \
    RUNNER_ALLOW_FALLBACK=true \
    DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["sh", "-c", "CRUCIBLE_PORT=${PORT:-8080} python /app/product/entrypoints/http-api/serve.py"]
