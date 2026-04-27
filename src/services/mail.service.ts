import config from '@/config/env.config';
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    host: config.nodeMailer.host,
    port: config.nodeMailer.port,
    secure: config.nodeMailer.secure,
    auth: {
        user: config.nodeMailer.email,
        pass: config.nodeMailer.password,
    },
});

export const sendPasswordResetEmail = async ({
    to,
    name,
    resetUrl,
}: {
    to: string;
    name: string;
    resetUrl: string;
}) => {
    const appName = config.nodeMailer.fromName;

    return transporter.sendMail({
        from: `"${appName}" <${config.nodeMailer.fromEmail}>`,
        to,
        subject: `${appName} password reset`,
        text: `Xin chao ${name},\n\nBan da yeu cau dat lai mat khau. Su dung lien ket sau trong vong ${config.auth.resetPasswordTokenExpirationMinutes} phut:\n${resetUrl}\n\nNeu ban khong yeu cau thao tac nay, vui long bo qua email nay.`,
        html: `
            <p>Xin chao ${name},</p>
            <p>Ban da yeu cau dat lai mat khau.</p>
            <p>Su dung lien ket sau trong vong ${config.auth.resetPasswordTokenExpirationMinutes} phut:</p>
            <p><a href="${resetUrl}">${resetUrl}</a></p>
            <p>Neu ban khong yeu cau thao tac nay, vui long bo qua email nay.</p>
        `,
    });
};
