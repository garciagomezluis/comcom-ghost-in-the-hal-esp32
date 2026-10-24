#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_log.h"
#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"

#include "buttons.h"
#include "display.h"
#include "radio.h"
#include "autobelayer.h"
#include "protocol.h"

static const char *TAG = "demo";

static volatile uint32_t s_seq = 0;
static volatile float s_kgf = 0;
static volatile uint32_t s_perdidas = 0;
static volatile uint32_t s_ultimo_ms = 0;   

static ab_t s_ab;                                      
static volatile ab_estado_t s_estado = EST_ESPERANDO;  
static volatile ab_motor_t s_motor = MOTOR_QUIETO;
static volatile ab_cmd_t s_ultimo_cmd = CMD_NINGUNO;
static QueueHandle_t s_cmd_queue;

static const uint8_t MAC_PLACA_B[6] = {0x80, 0x45, 0x6b, 0x36, 0x01, 0x34};

#define UI_PERIOD_MS 50

static void procesar_linea(const char *linea)
{
    uint32_t seq;
    float kgf;

    if (sscanf(linea, "T %" SCNu32 " %f", &seq, &kgf) == 2) {
        if (s_ultimo_ms != 0 && seq > s_seq + 1) {
            s_perdidas += seq - s_seq - 1;
        }
        s_seq = seq;
        s_kgf = kgf;
        ab_cmd_t cmd;
        if (xQueueReceive(s_cmd_queue, &cmd, 0) != pdTRUE) {
            cmd = CMD_NINGUNO;
        }
        ab_entrada_t in = {
            .kgf = kgf,
            .t_ms = seq * (1000 / AB_HZ),
            .cmd = cmd,
            .enlace_vivo = true,
        };
        ab_salida_t out;
        ab_paso(&s_ab, &in, &out);
        s_estado = out.estado;
        s_motor = out.motor;
        s_ultimo_cmd = out.ultimo_cmd;
        s_ultimo_ms = xTaskGetTickCount() * portTICK_PERIOD_MS;

        
        static ab_salida_t anterior;   
        static int muestras = 0;
        bool cambio = out.estado != anterior.estado
                   || out.motor != anterior.motor
                   || out.ultimo_cmd != anterior.ultimo_cmd;
        if (cambio || ++muestras >= 5) {
            printf("@S %s %s %s\n", ab_estado_nombre(out.estado),
                   ab_motor_nombre(out.motor), ab_cmd_nombre(out.ultimo_cmd));
            anterior = out;
            muestras = 0;
        }
        if (out.evento == EV_CAIDA) {
            printf("@E CAIDA pico=%.1f\n", ventana_pico(&s_ab.ventana));
        } else if (out.evento == EV_EMERGENCIA) {
            printf("@E EMERGENCIA\n");
        }
    } else if (strcmp(linea, "R") == 0) {
        ab_init(&s_ab, AB_PESO_DEFAULT_KG);
        ESP_LOGI(TAG, "reset");
        s_perdidas = 0;
        s_ultimo_ms = 0;
    } else {
        ESP_LOGW(TAG, "linea desconocida: '%s'", linea);
    }
}

static void serial_task(void *arg)
{
    uint8_t buf[64];
    char linea[64];
    int largo = 0;

    while (1) {
        int n = usb_serial_jtag_read_bytes(buf, sizeof(buf), portMAX_DELAY);
        for (int i = 0; i < n; i++) {
            char c = buf[i];
            if (c == '\r' || c == '\n') {
                if (largo > 0) {
                    linea[largo] = '\0';
                    procesar_linea(linea);
                    largo = 0;
                }
            } else if (largo < sizeof(linea) - 1) {
                linea[largo++] = c;
            } else {
                largo = 0;
            }
        }
    }
}


static ab_cmd_t boton_a_cmd(button_id_t id)
{
    switch (id) {
    case BTN_KEY1: return CMD_TENSION;
    case BTN_KEY2: return CMD_BAJAME;
    case BTN_KEY3: return CMD_SIGO;
    case BTN_KEY4: return CMD_AYUDA;
    default:       return CMD_NINGUNO;
    }
}


static const char *texto_para_b(ab_estado_t e)
{
    return e == EST_COLGADO ? "TE TENGO" : ab_estado_nombre(e);
}

void app_main(void)
{
    ESP_LOGI(TAG, "Hackathon board demo starting");

    bool display_ok = display_init() == ESP_OK;
    if (!display_ok) {
        ESP_LOGE(TAG, "display init failed - continuing without screen");
    }

    ESP_ERROR_CHECK(buttons_init());

    if (display_ok) {
        display_clear();
        display_text(10, 8, "THE BE SHARPS", false);
        display_text(10, 24, "ESP32-S3 dev board", false);
        display_text(10, 40, "Self test...", false);
        display_flush();
    }

    usb_serial_jtag_driver_config_t cfg = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    cfg.rx_buffer_size = 1024;
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&cfg));
    usb_serial_jtag_vfs_use_driver();

    ab_init(&s_ab, AB_PESO_DEFAULT_KG);
    s_cmd_queue = xQueueCreate(8, sizeof(ab_cmd_t));
    xTaskCreate(serial_task, "serial", 4096, NULL, 5, NULL);

    bool radio_ok = radio_init() == ESP_OK;
    if (!radio_ok) {
        ESP_LOGE(TAG, "radio init failed - continuing without ESP-NOW");
    }
    vTaskDelay(pdMS_TO_TICKS(500));

    while (1) {
        button_event_t ev;
        while (xQueueReceive(buttons_event_queue(), &ev, 0) == pdTRUE) {
            ab_cmd_t cmd = boton_a_cmd(ev.id);
            if (ev.pressed && cmd != CMD_NINGUNO) {
                xQueueSend(s_cmd_queue, &cmd, 0);
                ESP_LOGI(TAG, "comando %s", ab_cmd_nombre(cmd));
            }
        }

        radio_packet_t pkt;
        while (radio_ok && xQueueReceive(radio_queue(), &pkt, 0) == pdTRUE) {
            if (memcmp(pkt.from, MAC_PLACA_B, 6) != 0 || pkt.len != sizeof(CommandMessage)) {
                continue;
            }
            CommandMessage m;
            memcpy(&m, pkt.data, sizeof(m));
            if (m.commandType >= CMD_TENSION && m.commandType <= CMD_AYUDA) {
                ab_cmd_t cmd = (ab_cmd_t)m.commandType;
                xQueueSend(s_cmd_queue, &cmd, 0);
                ESP_LOGI(TAG, "comando de B: %s", ab_cmd_nombre(cmd));
            }
        }

        
        static int vueltas = 0;
        if (radio_ok && ++vueltas >= 4) {
            vueltas = 0;
            uint32_t ahora = xTaskGetTickCount() * portTICK_PERIOD_MS;
            bool hay_datos = s_ultimo_ms != 0 && ahora - s_ultimo_ms <= 1000;
            ab_estado_t estado = s_estado;
            StatusMessage st = {0};
            snprintf(st.statusText, sizeof(st.statusText), "%s",
                     hay_datos ? texto_para_b(estado) : "SIN DATOS");
            st.tensionReading = s_kgf;
            st.eventFlag = (estado == EST_CAIDA || estado == EST_EMERGENCIA) ? STATUS_ALERT : STATUS_NORMAL;
            radio_send(&st, sizeof(st));
        }

        if (display_ok) {
            char line[24];
            uint32_t ahora = xTaskGetTickCount() * portTICK_PERIOD_MS;
            display_clear();
            if (s_ultimo_ms == 0 || ahora - s_ultimo_ms > 1000) {
                display_text(2, 24, "ESPERANDO DATOS...", false);
            } else {
                bool alerta = (s_estado == EST_CAIDA || s_estado == EST_EMERGENCIA);
                bool encendido = !alerta || (ahora / 250) % 2 == 0;
                display_text(2, 0, ab_estado_nombre(s_estado), encendido);

                snprintf(line, sizeof(line), "KGF %.2f", s_kgf);
                display_text(2, 14, line, false);

                float kgf = s_kgf;
                if (kgf < 0) kgf = 0;
                if (kgf > 100) kgf = 100;
                display_draw_rect(0, 24, 128, 10);
                display_fill_rect(2, 26, (int)(kgf * 124 / 100), 6, true);

                snprintf(line, sizeof(line), "MOTOR %s", ab_motor_nombre(s_motor));
                display_text(2, 38, line, false);

                snprintf(line, sizeof(line), "CMD %s", ab_cmd_nombre(s_ultimo_cmd));
                display_text(2, 48, line, false);

                snprintf(line, sizeof(line), "PERDIDAS %" PRIu32, s_perdidas);
                display_text(2, 56, line, false);
            }
            display_flush();
        }
        vTaskDelay(pdMS_TO_TICKS(UI_PERIOD_MS));
    }
}
