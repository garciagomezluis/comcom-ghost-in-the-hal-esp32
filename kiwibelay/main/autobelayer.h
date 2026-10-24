#pragma once


#include <stdbool.h>
#include <stdint.h>


#define AB_PESO_DEFAULT_KG       70.0f
#define AB_FRICCION              0.65f


#define AB_FLOJA_MAX_KGF         0.5f
#define AB_SUBIDA_MIN_KGF        2.0f
#define AB_SUBIDA_MAX_KGF        5.0f
#define AB_CLIP_MIN_KGF          10.0f
#define AB_CLIP_MAX_KGF          15.0f
#define AB_COLGADO_MIN_KGF       20.0f  // promedio promedio por arriba de esto = colgado
#define AB_CAIDA_MULT_MIN        1.5f   

#define AB_HZ                    50
#define AB_SIN_RESPUESTA_MS      15000  // tras una caída, sin comandos : EMERGENCIA


#define AB_VENTANA_N             AB_HZ

typedef enum {
    EST_ESPERANDO,
    EST_ESCALANDO,
    EST_CLIPANDO,
    EST_CAIDA,
    EST_COLGADO,
    EST_BAJANDO,
    EST_EMERGENCIA,
} ab_estado_t;

typedef enum {
    MOTOR_QUIETO,
    MOTOR_RECOGE,
    MOTOR_DA,
    MOTOR_FRENA,
    MOTOR_BAJA,
} ab_motor_t;

typedef enum {
    CMD_NINGUNO,
    CMD_TENSION,
    CMD_BAJAME,
    CMD_SIGO,
    CMD_AYUDA,
} ab_cmd_t;

// Lo que la inferencia deduce de la tensión (no es el estado: es la "lectura" de la cuerda).
typedef enum {
    CTX_SIN_CARGA,
    CTX_SUBIENDO,
    CTX_CLIP,
    CTX_CAIDA,
    CTX_COLGADO,
} ab_contexto_t;

typedef enum {
    EV_NINGUNO,
    EV_CAIDA,
    EV_EMERGENCIA,
} ab_evento_t;

// Siempre llena: arranca en ceros (cuerda sin tensión) y cada muestra pisa a la más vieja.
typedef struct {
    float muestras[AB_VENTANA_N];
    int siguiente;
} ab_ventana_t;

// Lo que entra en cada paso (una muestra cada 20 ms).
typedef struct {
    float kgf;
    uint32_t t_ms;
    ab_cmd_t cmd;       
    bool enlace_vivo;    // Esto al final no llegamos a usarlo, queda en true 
} ab_entrada_t;

// Lo que sale de cada paso.
typedef struct {
    ab_estado_t estado;
    ab_motor_t motor;
    ab_cmd_t ultimo_cmd;
    ab_evento_t evento; 
} ab_salida_t;

// Todo lo que se recuerda entre pasos
typedef struct {
    ab_estado_t estado;
    ab_cmd_t ultimo_cmd;
    float peso_kg;
    ab_ventana_t ventana;
    uint32_t t_entrada_estado_ms;
    uint32_t t_caida_ms;
    bool respondio;
    bool bloqueado;
} ab_t;

void ab_init(ab_t *ab, float peso_kg);
void ab_paso(ab_t *ab, const ab_entrada_t *in, ab_salida_t *out);

void ventana_agregar(ab_ventana_t *v, float kgf);
float ventana_pico(const ab_ventana_t *v);
float ventana_promedio(const ab_ventana_t *v);
float ventana_ultima(const ab_ventana_t *v);
ab_contexto_t ab_inferir(const ab_t *ab);


const char *ab_estado_nombre(ab_estado_t e);
const char *ab_motor_nombre(ab_motor_t m);
const char *ab_cmd_nombre(ab_cmd_t c);
