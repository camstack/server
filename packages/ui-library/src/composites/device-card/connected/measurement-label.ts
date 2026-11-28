import type { HeroMeasurementQuantity } from '@dominevo/types'
import type { UiTextFn } from '../../../contexts/ui-text'

/** The short name of a quantity, under its value in the pie. */
export function quantityLabel(t: UiTextFn, quantity: HeroMeasurementQuantity): string {
  switch (quantity) {
    case 'temperature':
      return t('uiLibrary.sensorPie.quantity.temperature', 'Temperature')
    case 'humidity':
      return t('uiLibrary.sensorPie.quantity.humidity', 'Humidity')
    case 'power':
      return t('uiLibrary.sensorPie.quantity.power', 'Power')
    case 'contact':
      return t('uiLibrary.sensorPie.quantity.contact', 'Contact')
    case 'motion':
      return t('uiLibrary.sensorPie.quantity.motion', 'Motion')
    case 'illuminance':
      return t('uiLibrary.sensorPie.quantity.illuminance', 'Light')
    case 'text':
      return t('uiLibrary.sensorPie.quantity.text', 'State')
    case 'co2':
      return t('uiLibrary.sensorPie.quantity.co2', 'CO₂')
    case 'voc':
      return t('uiLibrary.sensorPie.quantity.voc', 'VOC')
    case 'pm25':
      return t('uiLibrary.sensorPie.quantity.pm25', 'PM2.5')
    case 'pm10':
      return t('uiLibrary.sensorPie.quantity.pm10', 'PM10')
    case 'aqi':
      return t('uiLibrary.sensorPie.quantity.aqi', 'Air quality')
  }
}
