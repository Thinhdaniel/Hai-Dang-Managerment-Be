import config from './env.config';

export const cloudinaryConfig = {
    cloud_name: config.cloudinaryConfig.cloudName,
    api_key: config.cloudinaryConfig.apiKey,
    api_secret: config.cloudinaryConfig.apiSecret,
};

export default cloudinaryConfig;
