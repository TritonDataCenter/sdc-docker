/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

@Library('jenkins-joylib@v1.0.2') _

pipeline {

    agent {
        label joyCommonLabels(image_ver: '15.4.1')
    }

    options {
        buildDiscarder(logRotator(numToKeepStr: '30'))
        timestamps()
    }

    stages {
        stage('check') {
            steps{
                sh('make check')
            }
        }
        // avoid bundling devDependencies
        stage('re-clean') {
            steps {
                sh('git clean -fdx')
            }
        }
        stage('build image and upload') {
            steps {
                joyBuildImageAndUpload()
            }
        }
    }

    post {
        always {
            joyMattermostNotification(channel: 'jenkins')
        }
    }

}
