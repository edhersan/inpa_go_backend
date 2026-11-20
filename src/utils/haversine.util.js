const EARTH_RADIUS_METERS = 6371000;

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
  const pLat1 = Number(lat1);
  const pLon1 = Number(lon1);
  const pLat2 = Number(lat2);
  const pLon2 = Number(lon2);

  if (
    !Number.isFinite(pLat1) ||
    !Number.isFinite(pLon1) ||
    !Number.isFinite(pLat2) ||
    !Number.isFinite(pLon2)
  ) {
    throw new Error('Coordenadas geográficas inválidas para cálculo Haversine.');
  }

  const dLat = toRadians(pLat2 - pLat1);
  const dLon = toRadians(pLon2 - pLon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(pLat1)) *
      Math.cos(toRadians(pLat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distancia = EARTH_RADIUS_METERS * c;

  return Number(distancia.toFixed(2));
}

function validarGeocerca(latReportada, lonReportada, latSede, lonSede, radioMetros) {
  const distancia_metros = calcularDistanciaMetros(
    latReportada,
    lonReportada,
    latSede,
    lonSede
  );
  const radio = Number(radioMetros);
  const ubicacion_valida = distancia_metros <= radio ? 1 : 0;

  return {
    distancia_metros,
    ubicacion_valida,
  };
}

module.exports = {
  EARTH_RADIUS_METERS,
  calcularDistanciaMetros,
  validarGeocerca,
};
