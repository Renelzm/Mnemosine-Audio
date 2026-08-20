const { Router } = require('express');
const { download, health, diag } = require('../controllers/audio.controller');

const router = Router();

router.get('/health', health);
router.get('/diag', diag);
router.post('/download', download);

module.exports = router;
