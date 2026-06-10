import mongoose, { ConnectOptions, Error } from 'mongoose';
import config from './env.config';

mongoose.set('strictQuery', true);

const syncRegisteredIndexes = async () => {
    if (!config.mongoose.syncIndexes) return;

    const modelNames = mongoose.modelNames();
    for (const modelName of modelNames) {
        const model = mongoose.model(modelName);
        await model.syncIndexes();
    }

    console.log(`MongoDB indexes synced for ${modelNames.length} models`);
};

// Connecting to MongoDB(Connecting to the Database)
export const connectDB = async () => {
    // mongoose.connect return promise
    const connection = await mongoose.connect(config.mongoose.url, {
        dbName: config.mongoose.options.dbName,
        serverSelectionTimeoutMS: config.mongoose.options.serverSelectionTimeoutMS,
        connectTimeoutMS: config.mongoose.options.connectTimeoutMS,
        socketTimeoutMS: config.mongoose.options.socketTimeoutMS,
        maxPoolSize: config.mongoose.options.maxPoolSize,
        minPoolSize: config.mongoose.options.minPoolSize,
        maxIdleTimeMS: config.mongoose.options.maxIdleTimeMS,
        heartbeatFrequencyMS: config.mongoose.options.heartbeatFrequencyMS,
    } as ConnectOptions);

    // @event connected: Emitted when this connection successfully connects to the db. May be emitted multiple times in reconnected scenarios
    mongoose.connection.on('connected', () => {
        console.log('MongoDB database connection established successfully');
    });

    mongoose.connection.on('reconnected', () => {
        console.log('Mongo Connection Reestablished');
    });

    // @event error: Emitted when an error occurs on this connection.
    mongoose.connection.on('error', (error: Error) => {
        console.log('MongoDB connection error. Please make sure MongoDB is running: ');
        console.log(`Mongo Connection ERROR: ${error}`);
    });

    // @event close
    mongoose.connection.on('close', () => {
        console.log('Mongo Connection Closed...');
    });

    // @event disconnected: Emitted after getting disconnected from the db
    mongoose.connection.on('disconnected', () => {
        console.log('MongoDB database connection is disconnected...');
        console.log('Trying to reconnect to Mongo ...');

        setTimeout(() => {
            mongoose.connect(config.mongoose.url, {
                dbName: config.mongoose.options.dbName,
                serverSelectionTimeoutMS: config.mongoose.options.serverSelectionTimeoutMS,
                socketTimeoutMS: config.mongoose.options.socketTimeoutMS,
                connectTimeoutMS: config.mongoose.options.connectTimeoutMS,
                maxPoolSize: config.mongoose.options.maxPoolSize,
                minPoolSize: config.mongoose.options.minPoolSize,
                maxIdleTimeMS: config.mongoose.options.maxIdleTimeMS,
                heartbeatFrequencyMS: config.mongoose.options.heartbeatFrequencyMS,
            } as ConnectOptions);
        }, 3000);
    });

    // @event close: Emitted after we disconnected and onClose executed on all of this connections models.
    process.on('SIGINT', () => {
        mongoose.connection.close().then(() => {
            console.log('MongoDB database connection is disconnected due to app termination...');
            process.exit(0); // close database connection
        });
    });

    await syncRegisteredIndexes();

    return connection;
};

export default connectDB;
