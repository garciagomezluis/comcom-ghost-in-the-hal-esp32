#include "autobelayer.h"

void ab_init(ab_t *ab, float peso_kg)
{
    ab->estado = EST_ESPERANDO;
    ab->ultimo_cmd = CMD_NINGUNO;
    ab->peso_kg = peso_kg;
    ab->ventana = (ab_ventana_t){0};
    ab->t_entrada_estado_ms = 0;
    ab->t_caida_ms = 0;
    ab->respondio = true;
    ab->bloqueado = false;
}

static void cambiar_estado(ab_t *ab, ab_estado_t nuevo, uint32_t t_ms)
{
    if (ab->estado == nuevo) {
        return;
    }
    ab->estado = nuevo;
    ab->t_entrada_estado_ms = t_ms;
    if (nuevo == EST_CAIDA) {
        ab->t_caida_ms = t_ms;
        ab->respondio = false;
    } else if (nuevo == EST_ESCALANDO) {
        ab->respondio = true;   // volver a escalar cuenta como respuesta
    }
}

static ab_motor_t motor_para(const ab_t *ab)
{
    switch (ab->estado) {
    case EST_ESCALANDO:
    case EST_CLIPANDO:
        return ventana_ultima(&ab->ventana) < AB_FLOJA_MAX_KGF ? MOTOR_RECOGE : MOTOR_DA;
    case EST_CAIDA:
    case EST_COLGADO:
    case EST_EMERGENCIA:
        return MOTOR_FRENA;
    case EST_BAJANDO:
        return MOTOR_BAJA;
    case EST_ESPERANDO:
        break;
    }
    return MOTOR_QUIETO;
}

//Este es el gran predictor de la máquina de estados.
void ab_paso(ab_t *ab, const ab_entrada_t *in, ab_salida_t *out)
{
    const ab_estado_t antes = ab->estado;

    ventana_agregar(&ab->ventana, in->kgf);
    if (in->cmd != CMD_NINGUNO) {
        ab->ultimo_cmd = in->cmd;
        ab->respondio = true;
    }
    const ab_contexto_t ctx = ab_inferir(ab);

    const bool hay_carga = ctx == CTX_COLGADO || ctx == CTX_CAIDA;
    const bool caida_sin_respuesta = (ab->estado == EST_CAIDA || ab->estado == EST_COLGADO) &&
                                     !ab->respondio &&
                                     in->t_ms - ab->t_caida_ms > (uint32_t)AB_SIN_RESPUESTA_MS;
    if (in->cmd == CMD_AYUDA || (!in->enlace_vivo && hay_carga) || caida_sin_respuesta) {
        cambiar_estado(ab, EST_EMERGENCIA, in->t_ms);
    }

    switch (ab->estado) {
    case EST_ESPERANDO:
        if (ctx == CTX_CAIDA) {
            cambiar_estado(ab, EST_CAIDA, in->t_ms);
        } else if (ctx == CTX_COLGADO) {
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        } else if (ctx == CTX_SUBIENDO || ctx == CTX_CLIP) {
            cambiar_estado(ab, EST_ESCALANDO, in->t_ms);
        }
        break;
    case EST_ESCALANDO:
        if (ctx == CTX_CAIDA) {
            cambiar_estado(ab, EST_CAIDA, in->t_ms);
        } else if (ctx == CTX_CLIP) {
            cambiar_estado(ab, EST_CLIPANDO, in->t_ms);
        } else if (ctx == CTX_COLGADO) {
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        } else if (in->cmd == CMD_TENSION) {
            ab->bloqueado = true;
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        }
        break;
    case EST_CLIPANDO:
        if (ctx == CTX_CAIDA) {
            cambiar_estado(ab, EST_CAIDA, in->t_ms);
        } else if (ctx == CTX_SUBIENDO) {
            cambiar_estado(ab, EST_ESCALANDO, in->t_ms);
        } else if (ctx == CTX_COLGADO) {
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        }
        break;
    case EST_CAIDA:
        if (ctx == CTX_COLGADO) {
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        } else if (ctx == CTX_SUBIENDO) {
            cambiar_estado(ab, EST_ESCALANDO, in->t_ms);
        }
        break;
    case EST_COLGADO:
        if (in->cmd == CMD_BAJAME) {
            ab->bloqueado = false;
            cambiar_estado(ab, EST_BAJANDO, in->t_ms);
        } else if (in->cmd == CMD_SIGO) {
            ab->bloqueado = false;
        } else if (ctx == CTX_SUBIENDO && !ab->bloqueado) {
            cambiar_estado(ab, EST_ESCALANDO, in->t_ms);
        }
        break;
    case EST_BAJANDO:
        if (in->cmd == CMD_SIGO) {
            cambiar_estado(ab, EST_COLGADO, in->t_ms);
        } else if (ventana_pico(&ab->ventana) < AB_FLOJA_MAX_KGF) {   // 1 s entero con la cuerda floja
            cambiar_estado(ab, EST_ESPERANDO, in->t_ms);
        }
        break;
    case EST_EMERGENCIA:
        break;   // solo sale con reset
    }

    out->evento = EV_NINGUNO;
    if (ab->estado != antes && ab->estado == EST_CAIDA) {
        out->evento = EV_CAIDA;
    } else if (ab->estado != antes && ab->estado == EST_EMERGENCIA) {
        out->evento = EV_EMERGENCIA;
    }
    out->estado = ab->estado;
    out->motor = motor_para(ab);
    out->ultimo_cmd = ab->ultimo_cmd;
}

void ventana_agregar(ab_ventana_t *v, float kgf)
{
    v->muestras[v->siguiente] = kgf;
    v->siguiente = (v->siguiente + 1) % AB_VENTANA_N;
}

float ventana_pico(const ab_ventana_t *v)
{
    float pico = v->muestras[0];
    for (int i = 1; i < AB_VENTANA_N; i++) {
        if (v->muestras[i] > pico) {
            pico = v->muestras[i];
        }
    }
    return pico;
}

float ventana_promedio(const ab_ventana_t *v)
{
    float suma = 0.0f;
    for (int i = 0; i < AB_VENTANA_N; i++) {
        suma += v->muestras[i];
    }
    return suma / AB_VENTANA_N;
}

float ventana_ultima(const ab_ventana_t *v)
{
    return v->muestras[(v->siguiente - 1 + AB_VENTANA_N) % AB_VENTANA_N];
}

//Acá es donde se infiere qué esta pasando en la vida real solo leyendo la tension de la cuerda
ab_contexto_t ab_inferir(const ab_t *ab)
{
    const float carga_colgado = ab->peso_kg * AB_FRICCION;
    const float pico = ventana_pico(&ab->ventana);
    const float promedio = ventana_promedio(&ab->ventana);

    // En orden de peligro: ante la duda, gana la caída.
    if (pico > AB_CAIDA_MULT_MIN * carga_colgado) {
        return CTX_CAIDA;
    }
    if (promedio > AB_COLGADO_MIN_KGF) {
        return CTX_COLGADO;
    }
    if (pico >= AB_CLIP_MIN_KGF && pico <= AB_CLIP_MAX_KGF) {
        return CTX_CLIP;
    }
    if (promedio >= AB_SUBIDA_MIN_KGF && promedio <= AB_SUBIDA_MAX_KGF) {
        return CTX_SUBIENDO;
    }
    return CTX_SIN_CARGA;
}

const char *ab_estado_nombre(ab_estado_t e)
{
    switch (e) {
    case EST_ESPERANDO:  return "ESPERANDO";
    case EST_ESCALANDO:  return "ESCALANDO";
    case EST_CLIPANDO:   return "CLIPANDO";
    case EST_CAIDA:      return "CAIDA";
    case EST_COLGADO:    return "COLGADO";
    case EST_BAJANDO:    return "BAJANDO";
    case EST_EMERGENCIA: return "EMERGENCIA";
    }
    return "?";
}

const char *ab_motor_nombre(ab_motor_t m)
{
    switch (m) {
    case MOTOR_QUIETO: return "QUIETO";
    case MOTOR_RECOGE: return "RECOGE";
    case MOTOR_DA:     return "DA";
    case MOTOR_FRENA:  return "FRENA";
    case MOTOR_BAJA:   return "BAJA";
    }
    return "?";
}

const char *ab_cmd_nombre(ab_cmd_t c)
{
    switch (c) {
    case CMD_NINGUNO: return "NINGUNO";
    case CMD_TENSION: return "TENSION";
    case CMD_BAJAME:  return "BAJAME";
    case CMD_SIGO:    return "SIGO";
    case CMD_AYUDA:   return "AYUDA";
    }
    return "?";
}
