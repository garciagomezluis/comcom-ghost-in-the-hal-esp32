#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"

#include "buttons.h"
#include "display.h"
#include "ayuda_frames.h"
#include "kiwi_frames.h"
#include "protocol.h"
#include "radio.h"

static const char *TAG = "wristband";

static const uint8_t s_ground_mac[6] = {
    0x80, 0x45, 0x6b, 0x36, 0x2f, 0xb4
};

#define REMOTE_ID              REMOTE_DEVICE_ID
#define UI_PERIOD_MS           20u
#define STATUS_TIMEOUT_MS      1000u
#define ANIMATION_FRAME_MS     140u
#define ANIMATION_FRAME_COUNT  5u
#define ANIMATION_LOOPS        4u
#define BAJAME_DURATION_MS \
    (ANIMATION_FRAME_COUNT * ANIMATION_FRAME_MS * ANIMATION_LOOPS)
#define SIGO_DURATION_MS \
    (ANIMATION_FRAME_COUNT * ANIMATION_FRAME_MS * ANIMATION_LOOPS)

#define AYUDA_LOOPS            3u
#define AYUDA_DURATION_MS \
    (CLIMBER_FRAME_COUNT * ANIMATION_FRAME_MS * AYUDA_LOOPS)

typedef enum {
    ANIMATION_NONE = 0,
    ANIMATION_BAJAME,
    ANIMATION_SIGO,
    ANIMATION_AYUDA,
} animation_type_t;

static StatusMessage s_last_status;
static bool s_have_status;
static bool s_display_available;
static bool s_display_dirty;
static uint32_t s_last_status_ms;

static animation_type_t s_animation;
static size_t s_animation_frame;
static uint32_t s_animation_next_ms;
static uint32_t s_animation_until_ms;

static uint32_t now_ms(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000ULL);
}

static void stop_animation(void)
{
    s_animation = ANIMATION_NONE;
    s_animation_frame = 0;
    s_animation_next_ms = 0;
    s_animation_until_ms = 0;
    s_display_dirty = true;
}

static void start_animation(animation_type_t animation, uint32_t duration_ms)
{
    const uint32_t now = now_ms();

    s_animation = animation;
    s_animation_frame = 0;
    s_animation_next_ms = now + ANIMATION_FRAME_MS;
    s_animation_until_ms = now + duration_ms;
    s_display_dirty = true;
}

static size_t current_animation_frame_count(void)
{
    switch (s_animation) {
        case ANIMATION_BAJAME:
        case ANIMATION_SIGO:
            return ANIMATION_FRAME_COUNT;

        case ANIMATION_AYUDA:
            return CLIMBER_FRAME_COUNT;

        case ANIMATION_NONE:
        default:
            return 0;
    }
}

static const uint8_t *current_animation_frame(void)
{
    switch (s_animation) {
        case ANIMATION_BAJAME:
            return BAJAME_FRAMES[s_animation_frame];

        case ANIMATION_SIGO:
            return SUBI_FRAMES[s_animation_frame];

        case ANIMATION_AYUDA:
            return AYUDA_FRAMES[s_animation_frame];

        case ANIMATION_NONE:
        default:
            return NULL;
    }
}

static void update_animation(void)
{
    if (s_animation == ANIMATION_NONE) {
        return;
    }

    const uint32_t now = now_ms();

    if ((int32_t)(now - s_animation_until_ms) >= 0) {
        stop_animation();
        return;
    }

    if ((int32_t)(now - s_animation_next_ms) < 0) {
        return;
    }

    const size_t frame_count = current_animation_frame_count();
    if (frame_count == 0) {
        stop_animation();
        return;
    }

    s_animation_next_ms = now + ANIMATION_FRAME_MS;
    s_animation_frame++;

    if (s_animation_frame >= frame_count) {
        s_animation_frame = 0;
    }

    s_display_dirty = true;
}

static void draw_bitmap_msb(
    int x,
    int y,
    int width,
    int height,
    const uint8_t *bitmap
)
{
    if (bitmap == NULL || width <= 0 || height <= 0) {
        return;
    }

    const int bytes_per_row = (width + 7) / 8;

    for (int row = 0; row < height; row++) {
        for (int col = 0; col < width; col++) {
            const size_t byte_index =
                (size_t)row * (size_t)bytes_per_row +
                (size_t)(col / 8);
            const uint8_t mask = (uint8_t)(0x80u >> (col % 8));
            const bool on = (bitmap[byte_index] & mask) != 0;

            display_set_pixel(x + col, y + row, on);
        }
    }
}

static void draw_animation_screen(void)
{
    const uint8_t *frame = current_animation_frame();
    if (frame == NULL) {
        return;
    }

    display_clear();
    draw_bitmap_msb(
        0,
        0,
        CLIMBER_FRAME_WIDTH,
        CLIMBER_FRAME_HEIGHT,
        frame
    );

    esp_err_t err = display_flush();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Animation display failed: %s", esp_err_to_name(err));
    }

    s_display_dirty = false;
}

static void draw_alert_screen(void)
{
    char line[32];

    display_clear();
    display_text(2, 1, "ALERTA", true);
    display_text(2, 16, s_last_status.statusText, false);

    snprintf(
        line,
        sizeof(line),
        "TENSION %.1f",
        (double)s_last_status.tensionReading
    );
    display_text(2, 30, line, false);
    display_text(22, 45, "ATENCION", true);

    esp_err_t err = display_flush();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Alert display failed: %s", esp_err_to_name(err));
    }

    s_display_dirty = false;
}

static void draw_status_screen(void)
{
    char line[32];

    display_clear();
    display_text(2, 1, "MUNEQUERA", true);

    if (!s_have_status) {
        display_text(2, 17, "SIN RESPUESTA", false);
        display_text(2, 31, "PRESIONE TECLA", false);
        display_text(2, 45, "PARA ENVIAR", false);
    } else {
        display_text(2, 16, s_last_status.statusText, false);
        snprintf(
            line,
            sizeof(line),
            "TENSION %.1f",
            (double)s_last_status.tensionReading
        );
        display_text(2, 30, line, false);
        display_text(
            2,
            45,
            s_last_status.eventFlag == STATUS_ALERT
                ? "!!! ALERTA !!!"
                : "ESTADO NORMAL",
            s_last_status.eventFlag == STATUS_ALERT
        );
    }

    esp_err_t err = display_flush();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Status display failed: %s", esp_err_to_name(err));
    }

    s_display_dirty = false;
}

static void draw_screen(void)
{
    if (!s_display_available) {
        return;
    }

    /* La animación de AYUDA tiene prioridad sobre la pantalla de alerta:
     * AYUDA es una alerta, pero queremos ver el S.O.S antes que el texto. */
    if (s_animation == ANIMATION_AYUDA) {
        draw_animation_screen();
        return;
    }

    if (s_have_status && s_last_status.eventFlag == STATUS_ALERT) {
        draw_alert_screen();
        return;
    }

    if (s_animation != ANIMATION_NONE) {
        draw_animation_screen();
        return;
    }

    draw_status_screen();
}

static bool command_from_button(button_id_t id, uint8_t *command_type)
{
    if (command_type == NULL) {
        return false;
    }

    switch (id) {
        case BTN_KEY1:
            *command_type = CMD_TENSION;
            return true;
        case BTN_KEY2:
            *command_type = CMD_BAJAME;
            return true;
        case BTN_KEY3:
            *command_type = CMD_SIGO;
            return true;
        case BTN_KEY4:
            *command_type = CMD_AYUDA;
            return true;
        default:
            return false;
    }
}

static void set_local_command_preview(uint8_t command_type)
{
    memset(&s_last_status, 0, sizeof(s_last_status));

    switch (command_type) {
        case CMD_TENSION:
            strcpy(s_last_status.statusText, "CMD TENSION");
            break;
        case CMD_BAJAME:
            strcpy(s_last_status.statusText, "CMD BAJAME");
            break;
        case CMD_SIGO:
            strcpy(s_last_status.statusText, "CMD SIGO");
            break;
        case CMD_AYUDA:
            strcpy(s_last_status.statusText, "CMD AYUDA");
            s_last_status.eventFlag = STATUS_ALERT;
            break;
        default:
            strcpy(s_last_status.statusText, "CMD INVALIDO");
            s_last_status.eventFlag = STATUS_ALERT;
            break;
    }

    s_have_status = true;
    s_last_status_ms = now_ms();
}

static void start_command_animation(uint8_t command_type)
{
    switch (command_type) {
        case CMD_BAJAME:
            start_animation(ANIMATION_BAJAME, BAJAME_DURATION_MS);
            break;
        case CMD_SIGO:
            start_animation(ANIMATION_SIGO, SIGO_DURATION_MS);
            break;
        case CMD_TENSION:
            stop_animation();
            break;
        case CMD_AYUDA:
            start_animation(ANIMATION_AYUDA, AYUDA_DURATION_MS);
            break;
        default:
            stop_animation();
            break;
    }
}

static void send_command(uint8_t command_type)
{
    CommandMessage message = {
        .senderId = REMOTE_ID,
        .commandType = command_type,
        .timestamp = now_ms(),
    };

    esp_err_t err = radio_send(&message, sizeof(message));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not send command %u: %s",
                 command_type, esp_err_to_name(err));
        return;
    }

    ESP_LOGI(TAG, "Command sent: type=%u timestamp=%lu",
             command_type, (unsigned long)message.timestamp);

    set_local_command_preview(command_type);
    start_command_animation(command_type);
    s_display_dirty = true;
}

static void handle_button_event(const button_event_t *event)
{
    if (event == NULL || !event->pressed) {
        return;
    }

    uint8_t command_type;
    if (!command_from_button(event->id, &command_type)) {
        ESP_LOGI(TAG, "Ignored button %s; not assigned to a command",
                 buttons_name(event->id));
        return;
    }

    ESP_LOGI(TAG, "Button %s pressed", buttons_name(event->id));
    send_command(command_type);
}

static void sanitize_status(StatusMessage *status)
{
    if (status == NULL) {
        return;
    }

    status->statusText[sizeof(status->statusText) - 1] = '\0';

    for (size_t i = 0; i < sizeof(status->statusText); i++) {
        unsigned char c = (unsigned char)status->statusText[i];
        if (c == '\0') {
            break;
        }
        if (c < 32 || c > 126) {
            status->statusText[i] = '?';
        }
    }

    if (status->eventFlag != STATUS_NORMAL &&
        status->eventFlag != STATUS_ALERT) {
        status->eventFlag = STATUS_ALERT;
    }
}

static void handle_radio_packet(const radio_packet_t *packet)
{
    if (packet == NULL) {
        return;
    }

    if (memcmp(packet->from, s_ground_mac, sizeof(s_ground_mac)) != 0) {
        ESP_LOGW(TAG, "Ignoring packet from unknown MAC: " MACSTR,
                 MAC2STR(packet->from));
        return;
    }

    if (packet->len != sizeof(StatusMessage)) {
        ESP_LOGW(TAG, "Ignoring packet of %u bytes; expected %u",
                 packet->len, (unsigned)sizeof(StatusMessage));
        return;
    }

    StatusMessage status;
    memcpy(&status, packet->data, sizeof(status));
    sanitize_status(&status);

    s_last_status = status;
    s_have_status = true;
    s_last_status_ms = now_ms();

    /* Una alerta de la base corta las animaciones, salvo la de AYUDA
     * (la base suele contestar con una alerta y taparía el S.O.S). */
    if (status.eventFlag == STATUS_ALERT && s_animation != ANIMATION_AYUDA) {
        stop_animation();
    }

    s_display_dirty = true;

    ESP_LOGI(TAG,
             "Status received from ground: text='%s', tension=%.2f kgf, event=%u",
             s_last_status.statusText,
             (double)s_last_status.tensionReading,
             s_last_status.eventFlag);
}

void app_main(void)
{
    ESP_LOGI(TAG, "Wristband transmitter starting");

    esp_err_t err = display_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Display initialization failed: %s",
                 esp_err_to_name(err));
    } else {
        s_display_available = true;
    }

    ESP_ERROR_CHECK(buttons_init());
    ESP_ERROR_CHECK(radio_init());

    s_have_status = false;
    s_display_dirty = true;
    s_animation = ANIMATION_NONE;
    s_animation_frame = 0;
    s_animation_next_ms = 0;
    s_animation_until_ms = 0;
    s_last_status_ms = now_ms();

    if (s_display_available) {
        display_clear();
        display_text(8, 8, "MUNEQUERA", true);
        display_text(8, 25, "ESP-NOW", false);
        display_text(8, 42, "LISTA", false);

        err = display_flush();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Initial display flush failed: %s",
                     esp_err_to_name(err));
        }
    }

    while (true) {
        button_event_t event;
        while (xQueueReceive(buttons_event_queue(), &event, 0) == pdTRUE) {
            handle_button_event(&event);
        }

        radio_packet_t packet;
        while (xQueueReceive(radio_queue(), &packet, 0) == pdTRUE) {
            handle_radio_packet(&packet);
        }

        update_animation();

        const uint32_t now = now_ms();
        if (s_animation == ANIMATION_NONE &&
			s_have_status &&
			(now - s_last_status_ms) > STATUS_TIMEOUT_MS) {
			memset(&s_last_status, 0, sizeof(s_last_status));
            strcpy(s_last_status.statusText, "SIN BASE");
            s_last_status.tensionReading = 0.0f;
            s_last_status.eventFlag = STATUS_ALERT;
            s_have_status = true;
            s_display_dirty = true;
        }

        if (s_display_dirty) {
            draw_screen();
        }

        vTaskDelay(pdMS_TO_TICKS(UI_PERIOD_MS));
    }
}
