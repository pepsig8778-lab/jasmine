# API — ссылка на объявление → готовая картинка

Отправляете ссылку на товар Subito → получаете PNG в вашем оформлении
(шаблон, который вы настроили в конструкторе). QR-код можно направить
на любую свою ссылку.

**Базовый адрес:** `https://jasmine-am1b.onrender.com`

---

## Запрос

```
GET /api/image?key=КЛЮЧ&url=ССЫЛКА_НА_ТОВАР
```

Ответ — сразу картинка (`image/png`). Больше ничего не нужно.

### Параметры

| Параметр | Обяз. | Что это |
|----------|:-----:|---------|
| `key`    | да    | Ваш API-ключ. По нему выбирается **ваш** шаблон. |
| `url`    | да    | Ссылка на объявление subito.it. Из неё берутся цена, фото, название. |
| `qrUrl`  | нет   | Отдельная ссылка для QR-кода (и блоков `{{link}}`). Если не указать — QR ведёт на само объявление. Подойдёт любая ссылка. |
| `scale`  | нет   | Чёткость картинки. `1` — обычная (по умолчанию), `2` — в 2 раза больше пикселей (резче, но тяжелее), `3` — максимум. Для веба хватает `1`. |

### Ошибки

Вместо картинки приходит JSON `{"ok": false, "error": "текст"}`:

- `401` — ключ неверный или не передан
- `400` — ссылка не с subito.it или не на объявление
- `502` — Subito временно недоступен, повторите запрос

---

## Примеры

### cURL

```bash
# минимум: только товар (QR ведёт на объявление)
curl -o out.png "https://jasmine-am1b.onrender.com/api/image?key=КЛЮЧ&url=https://www.subito.it/.../annuncio-123.htm"

# товар + своя ссылка для QR
curl -o out.png "https://jasmine-am1b.onrender.com/api/image?key=КЛЮЧ&url=https://www.subito.it/.../annuncio-123.htm&qrUrl=https://ваш-сайт.ru/promo"
```

### Python

```python
import requests

r = requests.get("https://jasmine-am1b.onrender.com/api/image", params={
    "key":   "КЛЮЧ",
    "url":   "https://www.subito.it/.../annuncio-123.htm",
    "qrUrl": "https://ваш-сайт.ru/promo",   # можно убрать
})

if r.headers.get("content-type") == "image/png":
    open("out.png", "wb").write(r.content)     # успех — сохраняем картинку
else:
    print("Ошибка:", r.json()["error"])
```

### JavaScript (Node 18+)

```js
const KEY = "КЛЮЧ";
const url = "https://www.subito.it/.../annuncio-123.htm";
const qrUrl = "https://ваш-сайт.ru/promo";   // можно убрать

const api = "https://jasmine-am1b.onrender.com/api/image"
  + `?key=${KEY}`
  + `&url=${encodeURIComponent(url)}`
  + `&qrUrl=${encodeURIComponent(qrUrl)}`;

const r = await fetch(api);
if (r.headers.get("content-type") === "image/png") {
  const buf = Buffer.from(await r.arrayBuffer());
  require("fs").writeFileSync("out.png", buf);   // успех
} else {
  console.log("Ошибка:", (await r.json()).error);
}
```

---

## Оформление картинки

Вид (цвета, блоки, шрифты, положение QR) берётся из **вашего** шаблона:

1. Откройте конструктор, настройте всё как нужно.
2. Вкладка «Парсер Subito» → **«Опубликовать шаблон»**.
3. Готово — API с вашим ключом отдаёт картинки в этом оформлении.

Каждый ключ = свой шаблон.

## Полезно знать

- **Куда ведёт QR:** сначала `qrUrl` из запроса → потом «Ссылка для QR»
  из шаблона → если ничего нет, ссылка самого объявления.
- **Скорость:** обычно 1–6 секунд. Первый запрос после простоя дольше —
  бесплатный хостинг «засыпает» и просыпается до ~50 секунд.
- **Проверка связи:** `GET /api/status?key=КЛЮЧ` — покажет, что ключ рабочий
  и какой шаблон используется.
