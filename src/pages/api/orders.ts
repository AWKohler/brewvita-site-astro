import type { APIRoute } from "astro";

export const prerender = false;

const SQUARE_VERSION = "2025-10-16";
const squareEnvironment = (
    import.meta.env.SQUARE_ENVIRONMENT || "sandbox"
).toLowerCase();
const SQUARE_API_BASE =
    squareEnvironment === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";

type IncomingCartLine = {
    catalog_object_id?: unknown;
    modifier_catalog_object_ids?: unknown;
    quantity?: unknown;
};

type NormalizedLine = {
    catalogObjectId: string;
    modifierIds: string[];
    quantity: number;
};

function createJsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}

function normalizeQuantity(rawQuantity: unknown) {
    const parsed = Number(rawQuantity);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.floor(parsed);
}

function normalizeCartLines(cart: IncomingCartLine[]) {
    const grouped = new Map<string, NormalizedLine>();

    for (const line of cart) {
        const catalogObjectId =
            typeof line.catalog_object_id === "string"
                ? line.catalog_object_id.trim()
                : "";
        if (!catalogObjectId) continue;

        const modifierIds = Array.isArray(line.modifier_catalog_object_ids)
            ? Array.from(
                  new Set(
                      line.modifier_catalog_object_ids
                          .filter(
                              (modifierId): modifierId is string =>
                                  typeof modifierId === "string" &&
                                  modifierId.trim().length > 0,
                          )
                          .map((modifierId) => modifierId.trim()),
                  ),
              ).sort()
            : [];

        const quantity = normalizeQuantity(line.quantity);
        const key = `${catalogObjectId}::${modifierIds.join(",")}`;
        const existing = grouped.get(key);

        if (existing) {
            existing.quantity += quantity;
            continue;
        }

        grouped.set(key, {
            catalogObjectId,
            modifierIds,
            quantity,
        });
    }

    return Array.from(grouped.values());
}

async function squareRequest(path: string, init: RequestInit = {}) {
    const squareAccessToken = import.meta.env.SQUARE_ACCESS_TOKEN;
    if (!squareAccessToken) {
        throw new Error("Missing SQUARE_ACCESS_TOKEN.");
    }

    const response = await fetch(`${SQUARE_API_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${squareAccessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_VERSION,
            ...(init.headers ?? {}),
        },
    });

    const payload = await response.json();
    if (!response.ok) {
        const details =
            payload?.errors
                ?.map(
                    (error: { detail?: string; code?: string }) =>
                        error.detail || error.code,
                )
                ?.filter(Boolean)
                ?.join(", ") || `Square API error (${response.status})`;
        throw new Error(details);
    }

    return payload;
}

async function resolveLocationId() {
    const configured = import.meta.env.SQUARE_LOCATION_ID;
    if (configured) return configured;

    const locationsPayload = await squareRequest("/v2/locations");
    const active = (locationsPayload.locations || []).find(
        (location: { status?: string }) => location.status === "ACTIVE",
    );
    return active?.id || null;
}

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json().catch(() => null);
        const rawCart = Array.isArray(body?.cart)
            ? (body.cart as IncomingCartLine[])
            : [];

        const normalizedLines = normalizeCartLines(rawCart);
        if (!normalizedLines.length) {
            return createJsonResponse(
                { error: "Cart is empty or invalid." },
                400,
            );
        }

        const locationId = await resolveLocationId();
        if (!locationId) {
            return createJsonResponse(
                { error: "No active Square location is configured." },
                500,
            );
        }

        const lineItems = normalizedLines.map((line) => ({
            catalog_object_id: line.catalogObjectId,
            quantity: String(line.quantity),
            ...(line.modifierIds.length
                ? {
                      modifiers: line.modifierIds.map((modifierId) => ({
                          catalog_object_id: modifierId,
                          quantity: "1",
                      })),
                  }
                : {}),
        }));

        const createOrderPayload = {
            idempotency_key: crypto.randomUUID(),
            order: {
                location_id: locationId,
                line_items: lineItems,
            },
        };

        const squareResponse = await squareRequest("/v2/orders", {
            method: "POST",
            body: JSON.stringify(createOrderPayload),
        });

        return createJsonResponse({
            orderId: squareResponse?.order?.id || null,
            state: squareResponse?.order?.state || null,
            locationId,
            totalMoney: squareResponse?.order?.total_money || null,
            order: squareResponse?.order || null,
        });
    } catch (error) {
        return createJsonResponse(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unable to create order.",
            },
            500,
        );
    }
};
