'use strict';

const sigma        = require('./sigma');
const thermofisher = require('./thermofisher');
const vwr          = require('./vwr');
const cayman       = require('./cayman');
const tci          = require('./tci');
const strem        = require('./strem');

const vendors = [sigma, thermofisher, vwr, cayman, tci, strem];

module.exports = { vendors };
