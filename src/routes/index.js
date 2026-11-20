const express = require('express');
const authRoutes = require('./auth.routes');
const usuariosRoutes = require('./usuarios.routes');
const academicoRoutes = require('./academico.routes');
const sesionesRoutes = require('./sesiones.routes');
const reportesRoutes = require('./reportes.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/usuarios', usuariosRoutes);
router.use('/sesiones', sesionesRoutes);
router.use('/', academicoRoutes);
router.use('/', reportesRoutes);

module.exports = router;
