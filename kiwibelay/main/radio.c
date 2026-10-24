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

// Las dos placas tienen que estar en el mismo canal de Wi-Fi.
#define RADIO_CHANNEL   1
#define RX_QUEUE_LEN    8

static const uint8_t s_broadcast[ESP_NOW_ETH_ALEN] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static QueueHandle_t s_rx_queue;

// Corre en la task del Wi-Fi, no en la nuestra: solo copiamos el paquete a la cola.
static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    if (len <= 0) {
        return;
    }
    radio_packet_t pkt = {0};
    pkt.len = len > RADIO_MAX_PAYLOAD ? RADIO_MAX_PAYLOAD : len;
    memcpy(pkt.from, info->src_addr, ESP_NOW_ETH_ALEN);
    memcpy(pkt.data, data, pkt.len);
    xQueueSend(s_rx_queue, &pkt, 0);
}

esp_err_t radio_init(void)
{
    s_rx_queue = xQueueCreate(RX_QUEUE_LEN, sizeof(radio_packet_t));
    ESP_RETURN_ON_FALSE(s_rx_queue, ESP_ERR_NO_MEM, TAG, "no mem for queue");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "nvs erase failed");
        err = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs init failed");

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif init failed");
    err = esp_event_loop_create_default();
    ESP_RETURN_ON_FALSE(err == ESP_OK || err == ESP_ERR_INVALID_STATE, err, TAG, "event loop failed");

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&cfg), TAG, "wifi init failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "wifi storage failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "wifi mode failed");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "wifi start failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_channel(RADIO_CHANNEL, WIFI_SECOND_CHAN_NONE), TAG, "wifi channel failed");

    ESP_RETURN_ON_ERROR(esp_now_init(), TAG, "esp-now init failed");
    ESP_RETURN_ON_ERROR(esp_now_register_recv_cb(on_recv), TAG, "recv cb failed");

    esp_now_peer_info_t peer = {
        .channel = RADIO_CHANNEL,
        .ifidx = WIFI_IF_STA,
        .encrypt = false,
    };
    memcpy(peer.peer_addr, s_broadcast, ESP_NOW_ETH_ALEN);
    ESP_RETURN_ON_ERROR(esp_now_add_peer(&peer), TAG, "add peer failed");

    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    ESP_LOGI(TAG, "ESP-NOW ready, my MAC is " MACSTR, MAC2STR(mac));
    return ESP_OK;
}

esp_err_t radio_send(const void *data, size_t len)
{
    ESP_RETURN_ON_FALSE(len > 0 && len <= RADIO_MAX_PAYLOAD, ESP_ERR_INVALID_SIZE, TAG, "bad length %u", (unsigned)len);
    return esp_now_send(s_broadcast, data, len);
}

QueueHandle_t radio_queue(void)
{
    return s_rx_queue;
}
