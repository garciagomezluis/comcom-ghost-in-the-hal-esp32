#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "nvs_flash.h"

#include "radio.h"

static const char *TAG = "radio";

#define RADIO_CHANNEL 1
#define RX_QUEUE_LEN  8

static const uint8_t s_broadcast[ESP_NOW_ETH_ALEN] = {
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff
};

static QueueHandle_t s_rx_queue;

static void on_recv(
    const esp_now_recv_info_t *info,
    const uint8_t *data,
    int len
)
{
    if (info == NULL ||
        data == NULL ||
        len <= 0 ||
        s_rx_queue == NULL) {
        return;
    }

    radio_packet_t packet = {0};

    packet.len = len > RADIO_MAX_PAYLOAD
        ? RADIO_MAX_PAYLOAD
        : (uint8_t)len;

    memcpy(packet.from, info->src_addr, ESP_NOW_ETH_ALEN);
    memcpy(packet.data, data, packet.len);

    if (xQueueSend(s_rx_queue, &packet, 0) != pdTRUE) {
        ESP_LOGW(TAG, "RX queue full; packet discarded");
    }
}

esp_err_t radio_init(void)
{
    if (s_rx_queue != NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    s_rx_queue = xQueueCreate(
        RX_QUEUE_LEN,
        sizeof(radio_packet_t)
    );

    ESP_RETURN_ON_FALSE(
        s_rx_queue != NULL,
        ESP_ERR_NO_MEM,
        TAG,
        "could not create RX queue"
    );

    esp_err_t err = nvs_flash_init();

    if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
        err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_RETURN_ON_ERROR(
            nvs_flash_erase(),
            TAG,
            "could not erase NVS"
        );

        err = nvs_flash_init();
    }

    ESP_RETURN_ON_ERROR(
        err,
        TAG,
        "could not initialize NVS"
    );

    ESP_RETURN_ON_ERROR(
        esp_netif_init(),
        TAG,
        "could not initialize network interface"
    );

    err = esp_event_loop_create_default();

    ESP_RETURN_ON_FALSE(
        err == ESP_OK || err == ESP_ERR_INVALID_STATE,
        err,
        TAG,
        "could not create event loop"
    );

    wifi_init_config_t wifi_config = WIFI_INIT_CONFIG_DEFAULT();

    ESP_RETURN_ON_ERROR(
        esp_wifi_init(&wifi_config),
        TAG,
        "could not initialize Wi-Fi"
    );

    ESP_RETURN_ON_ERROR(
        esp_wifi_set_storage(WIFI_STORAGE_RAM),
        TAG,
        "could not configure Wi-Fi storage"
    );

    ESP_RETURN_ON_ERROR(
        esp_wifi_set_mode(WIFI_MODE_STA),
        TAG,
        "could not set Wi-Fi station mode"
    );

    ESP_RETURN_ON_ERROR(
        esp_wifi_start(),
        TAG,
        "could not start Wi-Fi"
    );

    ESP_RETURN_ON_ERROR(
        esp_wifi_set_channel(
            RADIO_CHANNEL,
            WIFI_SECOND_CHAN_NONE
        ),
        TAG,
        "could not set Wi-Fi channel"
    );

    ESP_RETURN_ON_ERROR(
        esp_now_init(),
        TAG,
        "could not initialize ESP-NOW"
    );

    ESP_RETURN_ON_ERROR(
        esp_now_register_recv_cb(on_recv),
        TAG,
        "could not register ESP-NOW RX callback"
    );

    esp_now_peer_info_t peer = {
        .channel = RADIO_CHANNEL,
        .ifidx = WIFI_IF_STA,
        .encrypt = false,
    };

    memcpy(
        peer.peer_addr,
        s_broadcast,
        ESP_NOW_ETH_ALEN
    );

    ESP_RETURN_ON_ERROR(
        esp_now_add_peer(&peer),
        TAG,
        "could not add broadcast peer"
    );

    uint8_t mac[ESP_NOW_ETH_ALEN] = {0};

    ESP_RETURN_ON_ERROR(
        esp_wifi_get_mac(WIFI_IF_STA, mac),
        TAG,
        "could not read station MAC"
    );

    ESP_LOGI(
        TAG,
        "ESP-NOW ready; channel=%d; MAC=" MACSTR,
        RADIO_CHANNEL,
        MAC2STR(mac)
    );

    return ESP_OK;
}

esp_err_t radio_send(const void *data, size_t len)
{
    ESP_RETURN_ON_FALSE(
        data != NULL,
        ESP_ERR_INVALID_ARG,
        TAG,
        "payload is NULL"
    );

    ESP_RETURN_ON_FALSE(
        len > 0 && len <= RADIO_MAX_PAYLOAD,
        ESP_ERR_INVALID_SIZE,
        TAG,
        "invalid payload size: %u",
        (unsigned)len
    );

    return esp_now_send(
        s_broadcast,
        data,
        len
    );
}

QueueHandle_t radio_queue(void)
{
    return s_rx_queue;
}