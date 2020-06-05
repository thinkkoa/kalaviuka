/**
 * @ author: richen
 * @ copyright: Copyright (c) - <richenlin(at)gmail.com>
 * @ license: MIT
 * @ version: 2020-06-05 09:31:14
 */
// tslint:disable-next-line: no-import-side-effect
import "reflect-metadata";
import * as helper from "think_lib";
import logger from "think_logger";
import { Container, IOCContainer } from "think_container";
import { SCHEDULE_KEY } from "./Constants";
import { CronJob } from "cron";
import { Locker, RedisOptions } from "../util/Locker";
import { recursiveGetMetadata } from "../util/Lib";

/**
 * Schedule task
 *
 * @export
 * @param {string} cron
 * * Seconds: 0-59
 * * Minutes: 0-59
 * * Hours: 0-23
 * * Day of Month: 1-31
 * * Months: 0-11 (Jan-Dec)
 * * Day of Week: 0-6 (Sun-Sat)
 * 
 * @returns {MethodDecorator}
 */
export function Scheduled(cron: string): MethodDecorator {
    if (helper.isEmpty(cron)) {
        // cron = "0 * * * * *";
        throw Error("ScheduleJob rule is not defined");
    }

    return (target, propertyKey: string, descriptor: PropertyDescriptor) => {
        IOCContainer.attachPropertyData(SCHEDULE_KEY, {
            cron,
            method: propertyKey
        }, target, propertyKey);
    };
}

/**
 * Redis-based distributed locks. Reids server config from db.ts.
 *
 * @export
 * @param {string} [name] The locker name. If name is duplicated, lock sharing contention will result.
 * @param {number} [lockTimeOut] Automatic release of lock within a limited maximum time.
 * @param {number} [waitLockInterval] Try to acquire lock every interval time(millisecond).
 * @param {number} [waitLockTimeOut] When using more than TimeOut(millisecond) still fails to get the lock and return failure.
 * 
 * @returns {MethodDecorator}
 */
export function SchedulerLock(name?: string, lockTimeOut?: number, waitLockInterval?: number, waitLockTimeOut?: number): MethodDecorator {
    return (target: any, methodName: string, descriptor: PropertyDescriptor) => {
        const componentType = IOCContainer.getType(target);
        if (componentType === "CONTROLLER") {
            throw Error("SchedulerLock decorator cannot be used in the controller class.");
        }
        const { value, configurable, enumerable } = descriptor;
        if (helper.isEmpty(name)) {
            const identifier = IOCContainer.getIdentifier(target) || (target.constructor ? target.constructor.name : "");
            name = `${identifier}_${methodName}`;
        }
        descriptor = {
            configurable,
            enumerable,
            writable: true,
            async value(...props: any[]) {
                // tslint:disable-next-line: no-invalid-this
                const redisOptions = this.app.config("SchedulerLock", "db") || this.app.config("redis", "db");
                if (helper.isEmpty(redisOptions)) {
                    throw Error("Missing redis server configuration. Please write a configuration item with the key name 'SchedulerLock' or 'redis' in the db.ts file.");
                }
                const lockerCls = Locker.getInstance(redisOptions);
                let lockerFlag = false;
                if (!lockerCls) {
                    throw Error(`Redis connection failed. The method ${methodName} is not executed.`);
                }
                if (waitLockInterval || waitLockTimeOut) {
                    lockerFlag = await lockerCls.waitLock(name,
                        lockTimeOut,
                        waitLockInterval,
                        waitLockTimeOut
                    ).catch((er: any) => {
                        logger.error(er);
                        return false;
                    });
                } else {
                    lockerFlag = await lockerCls.lock(name, lockTimeOut).catch((er: any) => {
                        logger.error(er);
                        return false;
                    });
                }
                if (lockerFlag) {
                    try {
                        logger.info(`The locker ${name} executed.`);
                        // tslint:disable-next-line: no-invalid-this
                        const res = await value.apply(this, props);
                        return res;
                    } catch (e) {
                        return Promise.reject(e);
                    } finally {
                        if (lockerCls.unLock) {
                            await lockerCls.unLock(name).catch((er: any) => {
                                logger.error(er);
                            });
                        }
                    }
                } else {
                    logger.warn(`Redis lock ${name} acquisition failed. The method ${methodName} is not executed.`);
                    return;
                }
            }
        };
        return descriptor;
    };
}

/**
 * Redis-based distributed locks. Reids server config from db.ts.
 *
 * @export
 * @param {string} [name] The locker name. If name is duplicated, lock sharing contention will result.
 * @param {number} [lockTimeOut] Automatic release of lock within a limited maximum time.
 * @param {number} [waitLockInterval] Try to acquire lock every interval time(millisecond).
 * @param {number} [waitLockTimeOut] When using more than TimeOut(millisecond) still fails to get the lock and return failure.
 *
 * @returns {MethodDecorator}
 */
export const Lock = SchedulerLock;

/**
 * 
 *
 * @param {*} target
 * @param {Container} container
 * @param {string} method
 * @param {string} cron
 */
const execInjectSchedule = function (target: any, container: Container, method: string, cron: string) {
    const app = container.getApp();
    // tslint:disable-next-line: no-unused-expression
    app && app.once("appStart", () => {
        const identifier = IOCContainer.getIdentifier(target);
        const instance: any = container.getInsByClass(target);
        const name = `${identifier}_${method}`;

        if (instance && helper.isFunction(instance[method]) && cron) {
            // tslint:disable-next-line: no-unused-expression
            process.env.APP_DEBUG && logger.custom("think", "", `Register inject ${identifier} schedule key: ${method} => value: ${cron}`);
            new CronJob(cron, async function () {

                logger.info(`The schedule job ${name} started.`);
                try {
                    const res = await instance[method]();
                    return res;
                } catch (e) {
                    logger.error(e);
                }
            }).start();
        }
    });
};

/**
 * Inject schedule job
 *
 * @export
 * @param {*} target
 * @param {*} instance
 * @param {Container} container
 */
export function injectSchedule(target: any, instance: any, container: Container) {
    const metaDatas = recursiveGetMetadata(SCHEDULE_KEY, target);
    // tslint:disable-next-line: forin
    for (const meta in metaDatas) {
        for (const val of metaDatas[meta]) {
            if (val.cron && meta) {
                execInjectSchedule(target, container, meta, val.cron);
            }
        }
    }
}
