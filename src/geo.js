'use strict';

// Great-circle distance between two lat/lng points, in meters (Haversine).
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8; // mean Earth radius (meters)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

/**
 * Authoritative server-side geofence evaluation.
 * Returns { allowed, distance, reason, flagged, flagReason }.
 *
 * The check is intentionally conservative:
 *  - rejects missing/invalid coordinates
 *  - rejects when reported GPS accuracy is worse than the meeting threshold
 *  - allows entry only if (distance - accuracy) is plausibly inside the radius,
 *    but flags entries where the accuracy circle is large relative to the fence
 *    (a common signature of coarse IP-based or spoofed positioning).
 */
function evaluateGeofence(meeting, point) {
  const { latitude: clat, longitude: clng, radius_meters: radius, max_accuracy_meters: maxAcc } = meeting;

  if (!meeting.geofence_enabled) {
    return { allowed: true, distance: null, reason: 'geofence_disabled', flagged: false };
  }
  if (!isValidLatLng(clat, clng)) {
    return { allowed: false, distance: null, reason: 'meeting_has_no_location', flagged: false };
  }
  if (!point || !isValidLatLng(point.lat, point.lng)) {
    return { allowed: false, distance: null, reason: 'location_required', flagged: false };
  }

  const accuracy = Number.isFinite(point.accuracy) ? point.accuracy : null;
  if (accuracy === null) {
    return { allowed: false, distance: null, reason: 'accuracy_required', flagged: false };
  }
  if (accuracy > maxAcc) {
    return {
      allowed: false,
      distance: null,
      reason: 'accuracy_too_low',
      detail: `GPS accuracy ${Math.round(accuracy)}m exceeds the allowed ${maxAcc}m. Move outside or enable precise location.`,
      flagged: false,
    };
  }

  const distance = haversineMeters(clat, clng, point.lat, point.lng);

  // Allow if the *best case* position (distance minus accuracy uncertainty)
  // is within the fence. This avoids penalizing honest users with normal GPS jitter.
  const bestCase = distance - accuracy;
  const allowed = bestCase <= radius;

  // Flag suspicious-but-allowed entries for admin review.
  let flagged = false;
  let flagReason = null;
  if (allowed) {
    if (accuracy > radius) {
      flagged = true;
      flagReason = 'accuracy_exceeds_radius'; // uncertainty bigger than the fence itself
    } else if (accuracy === 0) {
      flagged = true;
      flagReason = 'accuracy_zero'; // exactly 0 accuracy is a hallmark of spoofing tools
    }
  }

  return {
    allowed,
    distance,
    reason: allowed ? 'inside' : 'outside',
    detail: allowed ? null : `You are about ${Math.round(distance)}m from the meeting; sign-in requires being within ${radius}m.`,
    flagged,
    flagReason,
  };
}

module.exports = { haversineMeters, isValidLatLng, evaluateGeofence };
